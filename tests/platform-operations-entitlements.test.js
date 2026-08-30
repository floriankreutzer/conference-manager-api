import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { PlatformOperationConflictError } from '../src/platform/application/platform-operation-errors.js';
import { createPlatformEntitlementOperationsService } from '../src/platform/application/entitlement-operations-service.js';
import { PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-08-28T12:00:00.000Z';

const CAPABILITIES = Object.freeze([
  { capabilityId: 'microsoft.directory', dependencies: [] },
  { capabilityId: 'microsoft.calendar', dependencies: ['microsoft.directory'] },
  { capabilityId: 'microsoft.calendar.write', dependencies: ['microsoft.calendar'] },
]);

function stateRecord(status = 'onboarding', revision = 3, entries = []) {
  return { tenantId: TENANT_ID, tenantStatus: status, revision, entries };
}

function applyInput(proposals, overrides = {}) {
  return {
    operatorContext: {},
    tenantId: TENANT_ID,
    proposals,
    expectedEntitlementRevision: 3,
    reason: 'Approved capability change.',
    confirmation: { action: PLATFORM_OPERATION.ENTITLEMENT_APPLY, tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function fixtures({ tenantStatus = 'onboarding', entries = [], packageProposals, overrides = {} } = {}) {
  const state = { reads: 0, writes: 0, receipt: null, permissions: [] };
  const defaultPackageProposals = packageProposals ?? [
    { capabilityId: 'microsoft.directory', enabled: true },
    { capabilityId: 'microsoft.calendar', enabled: true },
  ];
  const service = createPlatformEntitlementOperationsService({
    capabilityPolicy: { async list() { return CAPABILITIES; } },
    packageReader: {
      async list() {
        return {
          snapshotAt: NOW,
          nextCursor: null,
          items: [{
            packageId: 'standard',
            revision: 7,
            name: 'Standard',
            description: 'Directory and calendar.',
            status: 'active',
            proposals: [{ capabilityId: 'private.capability', enabled: true }],
            billingPrice: 'must-not-leak',
          }],
        };
      },
      async findById() {
        return {
          packageId: 'standard',
          revision: 7,
          name: 'Standard',
          description: 'Directory and calendar.',
          status: 'active',
          proposals: defaultPackageProposals,
        };
      },
    },
    entitlementReader: {
      async findTenantState() {
        state.reads += 1;
        return stateRecord(tenantStatus, 3, entries);
      },
    },
    entitlementTransactions: {
      async apply(values) {
        state.writes += 1;
        state.applied = values;
        const enabled = new Map(entries.map((entry) => [entry.capabilityId, entry.enabled]));
        for (const change of values.changes) enabled.set(change.capabilityId, change.enabled);
        const entitlements = stateRecord(tenantStatus, 4, [...enabled].map(([capabilityId, value]) => ({
          capabilityId,
          enabled: value,
          effectiveAt: NOW,
        })));
        state.receipt = { requestDigest: values.requestDigest, result: { entitlements } };
        return { outcome: 'updated', entitlements };
      },
    },
    operationReceiptReader: { async find() { return state.receipt; } },
    platformAuthorizationPolicy: {
      authorize(_principal, permission) {
        state.permissions.push(permission);
        return true;
      },
    },
    tenantTargetPolicy: {
      async authorize(_principal, tenantId) {
        state.targetTenantIds ??= [];
        state.targetTenantIds.push(tenantId);
        return true;
      },
      async queryScope() { return { mode: 'all', securityVersion: 1, scopeKey: 'all-1' }; },
    },
    operationEvidenceFactory: {
      async createMutation(values) {
        state.evidence = values;
        return { tenantAuditEvent: {}, platformAuditEvent: {} };
      },
    },
    clock: () => Date.parse(NOW),
    ...overrides,
  });
  return { service, state };
}

test('capability metadata comes from one injected canonical catalogue and package listing is descriptive only', async () => {
  const { service, state } = fixtures();
  const capabilities = await service.listCapabilities({ operatorContext: {} });
  assert.deepEqual(capabilities.items, [...CAPABILITIES].sort((left, right) => (
    left.capabilityId.localeCompare(right.capabilityId)
  )));
  assert.equal(state.permissions[0], PLATFORM_PERMISSION.ENTITLEMENT_READ);

  const packages = await service.listPackages({ operatorContext: {}, query: {} });
  assert.deepEqual(Object.keys(packages.items[0]), ['packageId', 'revision', 'name', 'description', 'status']);
  assert.doesNotMatch(JSON.stringify(packages), /proposals|billingPrice|must-not-leak|private\.capability/);
});

test('package preview is authoritative, versioned, and produces an atomic capability diff', async () => {
  const { service } = fixtures();
  const preview = await service.previewPackage({ operatorContext: {}, tenantId: TENANT_ID, packageId: 'standard' });
  assert.equal(preview.package.revision, 7);
  assert.equal(preview.plan.sourceRevision, 3);
  assert.deepEqual(preview.plan.changes.map(({ capabilityId, enabled }) => ({ capabilityId, enabled })), [
    { capabilityId: 'microsoft.directory', enabled: true },
    { capabilityId: 'microsoft.calendar', enabled: true },
  ]);
});

test('dependency and lifecycle rules fail closed before persistence', async () => {
  const missingDependency = fixtures();
  await assert.rejects(
    missingDependency.service.previewEntitlementChanges({
      operatorContext: {},
      tenantId: TENANT_ID,
      proposals: [{ capabilityId: 'microsoft.calendar', enabled: true }],
    }),
    (error) => error.code === 'PLATFORM_ENTITLEMENT_DEPENDENCY_MISSING',
  );
  assert.equal(missingDependency.state.writes, 0);

  const suspended = fixtures({ tenantStatus: 'suspended' });
  await assert.rejects(
    suspended.service.applyEntitlementChanges(applyInput([
      { capabilityId: 'microsoft.directory', enabled: true },
    ])),
    (error) => error.code === 'PLATFORM_ENTITLEMENT_GRANT_LIFECYCLE_DENIED',
  );
  assert.equal(suspended.state.writes, 0);

  const archived = fixtures({
    tenantStatus: 'archived',
    entries: [{ capabilityId: 'microsoft.directory', enabled: true, effectiveAt: NOW }],
  });
  await assert.rejects(
    archived.service.applyEntitlementChanges(applyInput([
      { capabilityId: 'microsoft.directory', enabled: false },
    ])),
    (error) => error.code === 'PLATFORM_ENTITLEMENT_TENANT_ARCHIVED',
  );
});

test('entitlement apply carries a dual-audit transaction contract and safely replays before current-state reads', async () => {
  const { service, state } = fixtures();
  const input = applyInput([
    { capabilityId: 'microsoft.directory', enabled: true },
    { capabilityId: 'microsoft.calendar', enabled: true },
  ]);
  const first = await service.applyEntitlementChanges(input);
  assert.equal(first.outcome, 'updated');
  assert.equal(state.writes, 1);
  assert.equal(state.reads, 1);
  assert.equal(state.applied.expectedEntitlementRevision, 3);
  assert.equal(state.evidence.operation, PLATFORM_OPERATION.ENTITLEMENT_APPLY);

  const replay = await service.applyEntitlementChanges(input);
  assert.equal(replay.outcome, 'idempotent');
  assert.equal(state.reads, 1, 'the idempotency receipt must be checked before stale entitlement state');
  assert.equal(state.writes, 1);

  await assert.rejects(
    service.applyEntitlementChanges(applyInput(input.proposals, { reason: 'Different payload.' })),
    (error) => error instanceof PlatformOperationConflictError && error.code === 'PLATFORM_IDEMPOTENCY_KEY_CONFLICT',
  );
});

test('package apply rejects preview drift and never performs sequential partial updates', async () => {
  const { service, state } = fixtures();
  await assert.rejects(
    service.applyPackage({
      operatorContext: {},
      tenantId: TENANT_ID,
      packageId: 'standard',
      expectedPackageRevision: 8,
      expectedEntitlementRevision: 3,
      reason: 'Approved package.',
      confirmation: { action: PLATFORM_OPERATION.ENTITLEMENT_APPLY, tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    (error) => error.code === 'PLATFORM_PACKAGE_REVISION_STALE',
  );
  assert.equal(state.writes, 0);
});
