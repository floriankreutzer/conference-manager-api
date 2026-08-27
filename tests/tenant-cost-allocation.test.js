import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantCostAllocationService } from '../src/application/tenant-cost-allocation-service.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from '../src/application/tenant-settings-errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import {
  TenantCostAllocationInputError,
  assertTenantCostAllocationTransition,
  createTenantCostAllocationSnapshot,
  normalizeTenantCostAllocation,
  normalizeTenantCostAllocationEntries,
} from '../src/domain/tenant-cost-allocation.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-08-27T10:00:00.000Z';

function costCenter(id, code, overrides = {}) {
  return {
    id,
    code,
    name: 'Cost center ' + code,
    group: null,
    active: true,
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return {
    allocationRequired: true,
    costCenters: [
      costCenter('center-a', 'A'),
      costCenter('center-b', 'B'),
      costCenter('center-c', 'C'),
    ],
    ...overrides,
  };
}

function principal(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [PERMISSION.TENANT_CONFIGURE],
    ...overrides,
  };
}

test('cost-center configuration is percentage-only and archive-safe', () => {
  const normalized = normalizeTenantCostAllocation(configuration());
  assert.equal(normalized.costCenters.length, 3);
  assert.throws(
    () => normalizeTenantCostAllocation({
      ...configuration(),
      allocationModel: 'amount',
    }),
    (error) => (
      error instanceof TenantCostAllocationInputError
      && error.code === 'TENANT_COST_ALLOCATION_INVALID'
    ),
  );
  assert.throws(
    () => assertTenantCostAllocationTransition(
      configuration(),
      configuration({
        costCenters: configuration().costCenters.slice(1),
      }),
    ),
    (error) => (
      error instanceof TenantCostAllocationInputError
      && error.code === 'TENANT_COST_CENTER_ARCHIVE_REQUIRED'
    ),
  );
  const archived = assertTenantCostAllocationTransition(
    configuration(),
    configuration({
      costCenters: configuration().costCenters.map((entry, index) => (
        index === 0 ? { ...entry, active: false } : entry
      )),
    }),
  );
  assert.equal(archived.costCenters[0].active, false);
});

test('allocation entries require unique active centers and an exact 100 percent total', () => {
  const valid = normalizeTenantCostAllocationEntries([
    { costCenterId: 'center-a', percentageBasisPoints: 6_000 },
    { costCenterId: 'center-b', percentageBasisPoints: 4_000 },
  ], configuration());
  assert.equal(valid.length, 2);

  const cases = [
    [
      [
        { costCenterId: 'center-a', percentageBasisPoints: 5_000 },
        { costCenterId: 'center-b', percentageBasisPoints: 4_999 },
      ],
      'TENANT_COST_ALLOCATION_TOTAL_INVALID',
    ],
    [
      [
        { costCenterId: 'center-a', percentageBasisPoints: 5_000 },
        { costCenterId: 'center-a', percentageBasisPoints: 5_000 },
      ],
      'TENANT_COST_ALLOCATION_COST_CENTER_DUPLICATE',
    ],
    [
      [{ costCenterId: 'other-tenant-center', percentageBasisPoints: 10_000 }],
      'TENANT_COST_ALLOCATION_COST_CENTER_UNAVAILABLE',
    ],
    [
      [],
      'TENANT_COST_ALLOCATION_REQUIRED',
    ],
  ];
  for (const [entries, code] of cases) {
    assert.throws(
      () => normalizeTenantCostAllocationEntries(entries, configuration()),
      (error) => (
        error instanceof TenantCostAllocationInputError
        && error.code === code
      ),
    );
  }
});

test('minor-unit rounding is exact and deterministic by remainder then center ID', () => {
  const snapshot = createTenantCostAllocationSnapshot(configuration(), {
    entries: [
      { costCenterId: 'center-a', percentageBasisPoints: 3_333 },
      { costCenterId: 'center-b', percentageBasisPoints: 3_333 },
      { costCenterId: 'center-c', percentageBasisPoints: 3_334 },
    ],
    totalMinor: 101,
    currency: 'EUR',
  });
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.allocatedMinor),
    [34, 33, 34],
  );
  assert.equal(snapshot.allocatedMinor, 101);
  assert.equal(snapshot.unallocatedMinor, 0);
  assert.equal(snapshot.totalBasisPoints, 10_000);
});

test('optional empty allocation is explicit and does not fabricate an assignment', () => {
  const snapshot = createTenantCostAllocationSnapshot(configuration({
    allocationRequired: false,
  }), {
    entries: [],
    totalMinor: 12_345,
    currency: 'EUR',
  });
  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.allocatedMinor, 0);
  assert.equal(snapshot.unallocatedMinor, 12_345);
  assert.equal(snapshot.totalBasisPoints, 0);
});

test('allocation snapshots use authoritative cost-center metadata', () => {
  assert.throws(
    () => createTenantCostAllocationSnapshot(configuration(), {
      entries: [{
        costCenterId: 'center-a',
        percentageBasisPoints: 10_000,
        name: 'Browser controlled',
      }],
      totalMinor: 100,
      currency: 'EUR',
    }),
    TenantCostAllocationInputError,
  );
  const snapshot = createTenantCostAllocationSnapshot(configuration(), {
    entries: [{ costCenterId: 'center-a', percentageBasisPoints: 10_000 }],
    totalMinor: 100,
    currency: 'EUR',
  });
  assert.equal(snapshot.entries[0].name, 'Cost center A');
  assert.equal(Object.hasOwn(snapshot.entries[0], 'tenantId'), false);
});

function serviceRuntime({ conflict = null } = {}) {
  const calls = [];
  const repository = {
    async current(tenantId) {
      assert.equal(tenantId, TENANT_ID);
      return { revision: 8, configuration: configuration() };
    },
    async update(args) {
      calls.push(args);
      if (conflict !== null) return { status: 'conflict', currentRevision: conflict };
      return { revision: args.nextRevision, configuration: args.configuration };
    },
    async history() {
      return [];
    },
    async revision() {
      return null;
    },
  };
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  return {
    calls,
    service: createTenantCostAllocationService({
      repository,
      authorizationPolicy,
      auditService: audit.service,
      clock: () => Date.parse(NOW),
    }),
  };
}

test('Tenant Admin cost-allocation mutation advances only its aggregate revision', async () => {
  const { calls, service } = serviceRuntime();
  const result = await service.update({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 8,
    configuration: configuration(),
  });
  assert.equal(result.revision, 9);
  assert.equal(calls[0].tenantId, TENANT_ID);
  assert.equal(calls[0].nextRevision, 9);
  assert.equal(calls[0].auditEvent.metadata.domain, 'cost_allocation');
});

test('cost-allocation administration denies missing permission and cross-Tenant context', async () => {
  const { calls, service } = serviceRuntime();
  const employee = principal({
    roles: [TENANT_ROLE.EMPLOYEE],
    permissions: [PERMISSION.REQUEST_READ],
  });
  const input = {
    principal: employee,
    tenantContext: { tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 8,
    configuration: configuration(),
  };
  await assert.rejects(service.update(input), AuthorizationDeniedError);
  await assert.rejects(
    service.update({
      ...input,
      principal: principal(),
      tenantContext: { tenantId: OTHER_TENANT_ID },
    }),
    AuthorizationDeniedError,
  );
  assert.equal(calls.length, 0);
});

test('stale cost-allocation writes expose only current revision', async () => {
  const { service } = serviceRuntime({ conflict: 12 });
  await assert.rejects(
    service.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 8,
      configuration: configuration(),
    }),
    (error) => (
      error instanceof TenantSettingsConflictError
      && error.currentRevision === 12
    ),
  );
});

test('request snapshot includes revision and server timestamp for historical persistence', async () => {
  const { service } = serviceRuntime();
  const snapshot = await service.snapshotForAuthoritativeRequest({
    tenantId: TENANT_ID,
    entries: [{ costCenterId: 'center-a', percentageBasisPoints: 10_000 }],
    totalMinor: 5_000,
    currency: 'EUR',
  });
  assert.equal(snapshot.configurationRevision, 8);
  assert.equal(snapshot.snapshottedAt, NOW);
  assert.equal(snapshot.entries[0].allocatedMinor, 5_000);
});

test('unsupported cost-allocation settings schema fails before persistence', async () => {
  const { calls, service } = serviceRuntime();
  await assert.rejects(
    service.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      schemaVersion: 0,
      expectedRevision: 8,
      configuration: configuration(),
    }),
    TenantSettingsInputError,
  );
  assert.equal(calls.length, 0);
});
