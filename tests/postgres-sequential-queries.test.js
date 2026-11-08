import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createPostgresTenantCatalogueRepository } from '../src/persistence/postgres/tenant-catalogue-repository.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { createPostgresPlatformProjectionRepository } from '../src/persistence/postgres/platform-projection-repository.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-08T12:00:00.000Z');
const EMPTY_CATALOGUE = {
  services: [], equipment: [], cateringPackages: [], cateringItems: [], roomPrices: [],
};

// Reject overlapping submissions rather than silently queuing them as pg8 does.
// Yield each query so Promise.all cannot accidentally pass with synchronous mocks.
function database({ failAt = null, absentAt = null } = {}) {
  let active = false;
  let released = false;
  const calls = [];
  const failure = new Error('INJECTED_QUERY_FAILURE');
  const client = {
    async query(input) {
      assert.equal(active, false, 'concurrent submission on one PostgreSQL client');
      assert.equal(released, false, 'query after release');
      active = true;
      const name = typeof input === 'string' ? input : input.name;
      calls.push(name);
      try {
        await setImmediate();
        if (name === failAt) throw failure;
        if (typeof input !== 'string' && !name.startsWith('platform-projection-refresh-')) {
          assert.equal(input.values[0], TENANT, 'preserve bound Tenant identity');
        }
        if (name === absentAt) return { rows: [], rowCount: 0 };
        let rows = [];
        if (['tenant-catalogue-current-tenant', 'tenant-catalogue-current-lock'].includes(name)) {
          rows = [{ id: TENANT, catalog_revision: 1, catalogue_effective_at: NOW }];
        } else if (name === 'tenant-catalogue-snapshot-read') {
          return { rows: [], rowCount: 0 };
        } else if (['tenant-catalogue-site-references', 'tenant-catalogue-room-references'].includes(name)) {
          rows = input.values[1].map((id) => ({ id }));
        } else if (['tenant-lifecycle-lock-current', 'tenant-lifecycle-change-cas'].includes(name)) {
          rows = [{ id: TENANT, display_name: 'Synthetic Tenant', status: 'active',
            lifecycle_revision: 1, customer_session_revision: 1, created_at: NOW, updated_at: NOW }];
        } else if (name === 'tenant-pilot-lock-ready-connection') {
          rows = [{ id: ACTOR, provider_reference: 'synthetic-provider' }];
        } else if (name === 'tenant-pilot-lock-ready-entitlements') {
          rows = [{ capability_id: 'microsoft.calendar' }, { capability_id: 'microsoft.directory' }];
        } else if (name.startsWith('tenant-pilot-lock-ready-')) {
          rows = [{}];
        } else if (name === 'platform-projection-refresh-candidates') {
          rows = [{ id: TENANT }];
        } else if (name === 'platform-projection-refresh-clock') {
          rows = [{ observed_at: NOW }];
        } else if (name === 'platform-projection-tenant-source') {
          rows = [{ id: TENANT, status: 'onboarding', lifecycle_revision: 1,
            entitlement_revision: 1, binding_status: null, invitation_id: null,
            consumed_at: null, connection_status: null, places_permission_status: null,
            calendars_permission_status: null, last_verified_at: null }];
        } else if (name === 'platform-projection-mapping-source') {
          rows = [{ total: 0, active: 0, missing: 0 }];
        }
        return { rows, rowCount: rows.length || (/upsert|insert|update/.test(name) ? 1 : 0) };
      } finally { active = false; }
    },
    release() {
      assert.equal(active, false, 'release must follow settled work');
      released = true;
    },
  };
  const pool = {
    async connect() { return client; },
    async query() { assert.fail('transaction must retain its checked-out client'); },
  };
  return { pool, client, calls, failure };
}

function catalogue(pool) {
  return createPostgresTenantCatalogueRepository(pool, {
    auditRepository: { async appendWithClient() { return true; } },
  });
}

const scenarios = [
  {
    name: 'catalogue snapshot', failureAt: 'tenant-catalogue-equipment-read',
    later: 'tenant-catalogue-packages-read',
    async run(pool) {
      const result = await catalogue(pool).loadCurrent(TENANT);
      assert.equal(result.revision, 1);
      assert.deepEqual(result.catalogue, EMPTY_CATALOGUE);
    },
  },
  {
    name: 'catalogue references and replacement', failureAt: 'tenant-catalogue-site-references',
    later: 'tenant-catalogue-room-references',
    async run(pool) {
      const result = await catalogue(pool).replace({
        tenantId: TENANT, actorUserId: ACTOR, correlationId: ACTOR,
        expectedRevision: 1, catalogue: EMPTY_CATALOGUE, changedAt: NOW,
        auditEventFor: () => ({}),
      });
      assert.equal(result.status, 'updated');
      assert.equal(result.current.revision, 2);
    },
  },
  {
    name: 'Tenant readiness transition', failureAt: 'tenant-pilot-lock-ready-binding',
    later: 'tenant-pilot-lock-ready-room',
    async run(pool) {
      const repository = createPostgresTenantRepository(pool, {
        auditRepository: { async appendWithClient() { return true; } },
      });
      const result = await repository.changeStatusIfReady({
        tenantId: TENANT, expectedStatus: 'onboarding', targetStatus: 'active', changedAt: NOW,
      });
      assert.equal(result.outcome, 'updated');
    },
  },
  {
    name: 'Platform projection', failureAt: 'platform-projection-entitlement-source',
    later: 'platform-projection-mapping-source',
    async run(pool) {
      const result = await createPostgresPlatformProjectionRepository(pool).refreshBatch();
      assert.deepEqual(result, { refreshedCount: 1, observedAt: NOW.toISOString() });
    },
  },
];

for (const scenario of scenarios) {
  test(`${scenario.name} retains one client and awaits each query before commit`, async () => {
    const db = database();
    await scenario.run(db.pool);
    assert.equal(db.calls.at(-1), 'COMMIT');
    assert.equal(db.calls.includes('ROLLBACK'), false);
  });

  test(`${scenario.name} stops at the actual query failure and rolls back before release`, async () => {
    const db = database({ failAt: scenario.failureAt });
    await assert.rejects(scenario.run(db.pool), (error) => error === db.failure);
    assert.equal(db.calls.includes(scenario.failureAt), true);
    assert.equal(db.calls.includes(scenario.later), false);
    assert.equal(db.calls.includes('COMMIT'), false);
    assert.equal(db.calls.at(-1), 'ROLLBACK');
  });
}

test('missing Tenant remains absent without catalogue queries', async () => {
  const db = database({ absentAt: 'tenant-catalogue-current-tenant' });
  assert.equal(await catalogue(db.pool).loadCurrent(TENANT), null);
  assert.equal(db.calls.includes('tenant-catalogue-services-read'), false);
  assert.equal(db.calls.at(-1), 'COMMIT');
});

test('missing readiness binding cannot activate a Tenant', async () => {
  const db = database({ absentAt: 'tenant-pilot-lock-ready-binding' });
  const repository = createPostgresTenantRepository(db.pool, {
    auditRepository: { async appendWithClient() { assert.fail('no audit for an unperformed transition'); } },
  });
  const result = await repository.changeStatusIfReady({
    tenantId: TENANT, expectedStatus: 'onboarding', targetStatus: 'active', changedAt: NOW,
  });
  assert.equal(result.outcome, 'not_ready');
  assert.equal(db.calls.includes('tenant-lifecycle-change-cas'), false);
  assert.equal(db.calls.at(-1), 'COMMIT');
});
