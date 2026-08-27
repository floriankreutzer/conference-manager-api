import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditService } from '../src/audit/audit-service.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createTenantBookingPolicyService } from '../src/application/tenant-booking-policy-service.js';
import { createTenantCostAllocationService } from '../src/application/tenant-cost-allocation-service.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from '../src/application/tenant-settings-errors.js';
import { TenantCostAllocationInputError } from '../src/domain/tenant-cost-allocation.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresTenantBookingPolicyRepository } from '../src/persistence/postgres/tenant-booking-policy-repository.js';
import { createPostgresTenantCostAllocationRepository } from '../src/persistence/postgres/tenant-cost-allocation-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = '81818181-8181-4181-8181-818181818181';
const TENANT_B = '82828282-8282-4282-8282-828282828282';
const USER_A = '83838383-8383-4383-8383-838383838383';
const USER_B = '84848484-8484-4484-8484-848484848484';
const CORRELATION_A = '85858585-8585-4585-8585-858585858585';
const AUDIT_KEY = 'tenant-policy-cost-audit-key-at-least-32-bytes';
const NOW = '2026-08-27T10:00:00.000Z';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) {
    throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  }
  return { mode: 'test', ...database };
}

function principal(tenantId = TENANT_A, userId = USER_A) {
  return {
    tenantId,
    userId,
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [PERMISSION.TENANT_CONFIGURE],
  };
}

function policyVersion(id, effectiveFrom, references = {}) {
  return {
    id,
    effectiveFrom,
    rules: {
      minimumLeadTimeMinutes: 0,
      maximumAdvanceMinutes: 527_040,
      cancellationWindowMinutes: 0,
      changeWindowMinutes: 0,
      maximumParticipants: 100_000,
      allowedSiteIds: references.siteIds ?? [],
      allowedRoomIds: references.roomIds ?? [],
      allowedServiceIds: references.serviceIds ?? [],
    },
  };
}

function policyConfiguration(current, version) {
  return {
    versions: [...current.versions, version],
  };
}

function costConfiguration(code = 'A') {
  return {
    allocationRequired: true,
    costCenters: [{
      id: 'center-' + code.toLowerCase(),
      code,
      name: 'Cost center ' + code,
      group: 'Operations',
      active: true,
    }],
  };
}

async function seed(pool) {
  for (const [tenantId, name] of [
    [TENANT_A, 'Policy Tenant A'],
    [TENANT_B, 'Policy Tenant B'],
  ]) {
    await pool.query(
      'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
      [tenantId, name, 'active'],
    );
  }
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3), ($4, $5, $6)',
    [TENANT_A, USER_A, 'Admin A', TENANT_B, USER_B, 'Admin B'],
  );
  for (const [tenantId, suffix] of [[TENANT_A, 'a'], [TENANT_B, 'b']]) {
    await pool.query(
      'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
      [tenantId, 'site-' + suffix, 'Site ' + suffix],
    );
    await pool.query(
      'INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, 'room-' + suffix, 'site-' + suffix, 'Room ' + suffix, 20],
    );
    await pool.query(
      'INSERT INTO services (tenant_id, id, name) VALUES ($1, $2, $3)',
      [tenantId, 'service-' + suffix, 'Service ' + suffix],
    );
  }
}

async function clean(pool) {
  const tenants = [TENANT_A, TENANT_B];
  await removeSaas2TenantAdministrationFixtures(pool, tenants);
  await pool.query(
    'ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only',
  );
  await pool.query(
    'ALTER TABLE tenant_booking_policy_revisions DISABLE TRIGGER ALL',
  );
  await pool.query(
    'ALTER TABLE tenant_cost_allocation_revisions DISABLE TRIGGER ALL',
  );
  try {
    await pool.query(
      'DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])',
      [tenants],
    );
    await pool.query(
      'DELETE FROM tenant_booking_policy_revisions WHERE tenant_id = ANY($1::uuid[])',
      [tenants],
    );
    await pool.query(
      'DELETE FROM tenant_cost_allocation_revisions WHERE tenant_id = ANY($1::uuid[])',
      [tenants],
    );
  } finally {
    await pool.query(
      'ALTER TABLE tenant_cost_allocation_revisions ENABLE TRIGGER ALL',
    );
    await pool.query(
      'ALTER TABLE tenant_booking_policy_revisions ENABLE TRIGGER ALL',
    );
    await pool.query(
      'ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only',
    );
  }
  await pool.query(
    'DELETE FROM tenant_cost_centers WHERE tenant_id = ANY($1::uuid[])',
    [tenants],
  );
  await pool.query(
    'DELETE FROM tenant_cost_allocation_configuration WHERE tenant_id = ANY($1::uuid[])',
    [tenants],
  );
  await pool.query(
    'DELETE FROM tenant_booking_policy_configuration WHERE tenant_id = ANY($1::uuid[])',
    [tenants],
  );
  await pool.query(
    'DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])',
    [tenants],
  );
  await pool.query(
    'DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])',
    [tenants],
  );
  await pool.query(
    'DELETE FROM services WHERE tenant_id = ANY($1::uuid[])',
    [tenants],
  );
  await pool.query(
    'DELETE FROM users WHERE tenant_id = ANY($1::uuid[])',
    [tenants],
  );
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
}

test('booking policies and cost allocation are Tenant-scoped and audit-atomic in PostgreSQL', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await seed(pool);

  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, {
    hmacSecret: AUDIT_KEY,
  });
  const auditService = createAuditService({
    repository: auditRepository,
    authorizationPolicy,
  });
  const policyRepository = createPostgresTenantBookingPolicyRepository(pool, {
    auditRepository,
  });
  const costRepository = createPostgresTenantCostAllocationRepository(pool, {
    auditRepository,
  });
  const policyService = createTenantBookingPolicyService({
    repository: policyRepository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse(NOW),
  });
  const costService = createTenantCostAllocationService({
    repository: costRepository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse(NOW),
  });

  const policyInitial = await policyRepository.current(TENANT_A);
  assert.equal(policyInitial.revision, 1);
  assert.equal(policyInitial.configuration.versions[0].id, 'platform-default-v1');
  assert.deepEqual(
    await policyRepository.current(TENANT_B),
    policyInitial,
  );

  const policyA = policyConfiguration(
    policyInitial.configuration,
    policyVersion('tenant-a-v2', '2026-09-01T00:00:00.000Z', {
      siteIds: ['site-a'],
      roomIds: ['room-a'],
      serviceIds: ['service-a'],
    }),
  );
  const updatedPolicy = await policyService.update({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_A,
    schemaVersion: 1,
    expectedRevision: 1,
    configuration: policyA,
  });
  assert.equal(updatedPolicy.revision, 2);
  assert.equal((await policyRepository.current(TENANT_B)).revision, 1);

  await assert.rejects(
    policyService.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_A,
      schemaVersion: 1,
      expectedRevision: 2,
      configuration: policyConfiguration(
        policyA,
        policyVersion('cross-tenant', '2026-10-01T00:00:00.000Z', {
          siteIds: ['site-b'],
        }),
      ),
    }),
    TenantSettingsInputError,
  );
  assert.equal((await policyRepository.current(TENANT_A)).revision, 2);

  const concurrent = [
    policyConfiguration(
      policyA,
      policyVersion('concurrent-a', '2026-10-01T00:00:00.000Z'),
    ),
    policyConfiguration(
      policyA,
      policyVersion('concurrent-b', '2026-11-01T00:00:00.000Z'),
    ),
  ];
  const concurrentResults = await Promise.allSettled(
    concurrent.map((configuration) => policyService.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_A,
      schemaVersion: 1,
      expectedRevision: 2,
      configuration,
    })),
  );
  assert.equal(
    concurrentResults.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejectedPolicy = concurrentResults.find(
    (result) => result.status === 'rejected',
  );
  assert.ok(rejectedPolicy.reason instanceof TenantSettingsConflictError);
  assert.equal(rejectedPolicy.reason.currentRevision, 3);

  const policyAfterConcurrency = await policyRepository.current(TENANT_A);
  const failingAuditRepository = {
    async appendWithClient() {
      throw new Error('EXPECTED_AUDIT_FAILURE');
    },
  };
  const failingPolicyRepository = createPostgresTenantBookingPolicyRepository(
    pool,
    { auditRepository: failingAuditRepository },
  );
  const failingPolicyService = createTenantBookingPolicyService({
    repository: failingPolicyRepository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse(NOW),
  });
  await assert.rejects(
    failingPolicyService.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_A,
      schemaVersion: 1,
      expectedRevision: 3,
      configuration: policyConfiguration(
        policyAfterConcurrency.configuration,
        policyVersion('audit-failure', '2026-12-01T00:00:00.000Z'),
      ),
    }),
    /EXPECTED_AUDIT_FAILURE/,
  );
  assert.equal((await policyRepository.current(TENANT_A)).revision, 3);

  await assert.rejects(
    rollbackToVersion(pool, 24),
    (error) => (
      error.code === '55000'
      && error.message.includes('TENANT_BOOKING_POLICIES_REQUIRE_REVIEW')
    ),
  );
  await migrateUp(pool);

  const costInitial = await costRepository.current(TENANT_A);
  assert.deepEqual(costInitial.configuration, {
    allocationRequired: false,
    costCenters: [],
  });
  await costService.update({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_A,
    schemaVersion: 1,
    expectedRevision: 1,
    configuration: costConfiguration(),
  });
  assert.equal((await costRepository.current(TENANT_A)).revision, 2);
  assert.equal((await costRepository.current(TENANT_B)).revision, 1);

  await assert.rejects(
    costService.snapshotForAuthoritativeRequest({
      tenantId: TENANT_A,
      entries: [{
        costCenterId: 'center-b',
        percentageBasisPoints: 10_000,
      }],
      totalMinor: 1_000,
      currency: 'EUR',
    }),
    (error) => (
      error instanceof TenantCostAllocationInputError
      && error.code === 'TENANT_COST_ALLOCATION_COST_CENTER_UNAVAILABLE'
    ),
  );

  const failingCostRepository = createPostgresTenantCostAllocationRepository(
    pool,
    { auditRepository: failingAuditRepository },
  );
  const failingCostService = createTenantCostAllocationService({
    repository: failingCostRepository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse(NOW),
  });
  await assert.rejects(
    failingCostService.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_A,
      schemaVersion: 1,
      expectedRevision: 2,
      configuration: {
        ...costConfiguration(),
        costCenters: [
          ...costConfiguration().costCenters,
          {
            id: 'center-extra',
            code: 'EXTRA',
            name: 'Extra',
            group: null,
            active: true,
          },
        ],
      },
    }),
    /EXPECTED_AUDIT_FAILURE/,
  );
  const afterAuditFailure = await costRepository.current(TENANT_A);
  assert.equal(afterAuditFailure.revision, 2);
  assert.equal(afterAuditFailure.configuration.costCenters.length, 1);

  await assert.rejects(
    rollbackToVersion(pool, 25),
    (error) => (
      error.code === '55000'
      && error.message.includes('TENANT_COST_ALLOCATION_REQUIRE_REVIEW')
    ),
  );

  const events = await auditRepository.listByTenantId(TENANT_A, { limit: 100 });
  assert.ok(events.some((event) => (
    event.action === 'tenant.configuration.changed'
    && event.metadata.domain === 'booking_policies'
  )));
  assert.ok(events.some((event) => (
    event.action === 'tenant.configuration.changed'
    && event.metadata.domain === 'cost_allocation'
  )));
});
