import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPlatformProjectionRepository } from '../src/persistence/postgres/platform-projection-repository.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVED_AT = new Date('2026-08-28T12:00:00.000Z');

async function refresh({ connectionStatus = 'connected', lastVerifiedAt } = {}) {
  let readinessValues;
  const client = {
    async query(input) {
      if (typeof input === 'string') return { rows: [], rowCount: 0 };
      switch (input.name) {
        case 'platform-projection-refresh-candidates':
          return { rows: [{ id: TENANT_ID }], rowCount: 1 };
        case 'platform-projection-refresh-clock':
          return { rows: [{ observed_at: OBSERVED_AT }], rowCount: 1 };
        case 'platform-projection-tenant-source':
          return {
            rows: [{
              id: TENANT_ID,
              status: 'active',
              lifecycle_revision: 4,
              entitlement_revision: 3,
              binding_status: 'active',
              invitation_id: null,
              consumed_at: null,
              revoked_at: null,
              integration_id: '22222222-2222-4222-8222-222222222222',
              connection_status: connectionStatus,
              places_permission_status: 'granted',
              calendars_permission_status: 'granted',
              last_verified_at: new Date(lastVerifiedAt),
            }],
            rowCount: 1,
          };
        case 'platform-projection-entitlement-source':
          return {
            rows: [
              { capability_id: 'microsoft.calendar', enabled: true },
              { capability_id: 'microsoft.directory', enabled: true },
            ],
            rowCount: 2,
          };
        case 'platform-projection-mapping-source':
          return { rows: [{ total: 1, active: 1, missing: 0 }], rowCount: 1 };
        case 'platform-projection-health-source':
          return {
            rows: [{
              capability: 'free_busy',
              status: 'healthy',
              reason: null,
              last_checked_at: new Date('2026-08-28T11:50:00.000Z'),
              last_success_at: new Date('2026-08-28T11:50:00.000Z'),
            }],
            rowCount: 1,
          };
        case 'platform-projection-readiness-upsert':
          readinessValues = input.values;
          return { rows: [], rowCount: 1 };
        default:
          return { rows: [], rowCount: 1 };
      }
    },
    release() {},
  };
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { return client; },
  };

  const result = await createPostgresPlatformProjectionRepository(pool).refreshBatch();
  return { result, readinessValues };
}

test('Platform projection stores the canonical ready state without changing the check shape', async () => {
  const { result, readinessValues } = await refresh({
    lastVerifiedAt: '2026-08-28T11:50:00.000Z',
  });

  assert.deepEqual(result, { refreshedCount: 1, observedAt: OBSERVED_AT.toISOString() });
  assert.equal(readinessValues[4], 'ready');
  assert.deepEqual(readinessValues[5], []);
  const checks = JSON.parse(readinessValues[6]);
  assert.equal(checks.length, 8);
  assert.deepEqual(Object.keys(checks[0]), [
    'checkId',
    'category',
    'state',
    'reasonCode',
    'observedAt',
    'freshUntil',
  ]);
  assert.equal(Object.hasOwn(checks[0], 'freshness'), false);
});

test('Platform projection uses canonical failure and stale blocker precedence', async () => {
  const { readinessValues } = await refresh({
    connectionStatus: 'pending',
    lastVerifiedAt: '2026-08-28T11:30:00.000Z',
  });

  assert.equal(readinessValues[4], 'blocked');
  assert.deepEqual(readinessValues[5], [
    'microsoft.connection.connected.stale',
    'microsoft.connection.not_connected',
    'microsoft.permission.calendars.stale',
    'microsoft.permission.places.stale',
  ]);
});
