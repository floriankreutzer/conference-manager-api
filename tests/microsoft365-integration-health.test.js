import assert from 'node:assert/strict';
import test from 'node:test';
import { createMicrosoft365CapabilityHealthService } from '../src/application/microsoft365-capability-health-service.js';
import { createMicrosoft365ConnectionHealthView } from '../src/application/microsoft365-connection-health-view.js';
import { executeSafeProviderOperation } from '../src/integrations/provider-retry.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';

test('safe provider retry is bounded and stops immediately for permanent failures', async () => {
  const sleeps = [];
  let transientCalls = 0;
  const value = await executeSafeProviderOperation(async () => {
    transientCalls += 1;
    if (transientCalls < 3) throw Object.assign(new Error('transient'), { retryable: true });
    return 'ok';
  }, {
    classifyError: (error) => ({ retryable: error.retryable === true, retryAfterMs: null }),
    sleep: async (delayMs) => sleeps.push(delayMs),
  });
  assert.equal(value, 'ok');
  assert.equal(transientCalls, 3);
  assert.deepEqual(sleeps, [100, 200]);

  let permanentCalls = 0;
  await assert.rejects(
    executeSafeProviderOperation(async () => {
      permanentCalls += 1;
      throw new Error('permanent');
    }, {
      classifyError: () => ({ retryable: false, retryAfterMs: null }),
      sleep: async () => assert.fail('permanent failure must not sleep'),
    }),
    /permanent/,
  );
  assert.equal(permanentCalls, 1);
});

test('capability health preserves the last successful timestamp across later degradation', async () => {
  const rows = new Map();
  const repository = {
    async listByTenantIdAndIntegrationId() { return [...rows.values()]; },
    async record(input) {
      const previous = rows.get(input.capability);
      const row = Object.freeze({
        capability: input.capability,
        status: input.status,
        reason: input.reason,
        lastCheckedAt: input.checkedAt.toISOString(),
        lastSuccessAt: input.successful
          ? input.checkedAt.toISOString()
          : previous?.lastSuccessAt ?? null,
      });
      rows.set(input.capability, row);
      return row;
    },
  };
  let now = Date.parse('2026-08-25T18:00:00.000Z');
  const service = createMicrosoft365CapabilityHealthService({ repository, clock: () => now });
  await service.recordSuccess({ tenantId: TENANT_ID, integrationId: INTEGRATION_ID, capability: 'free_busy' });
  now += 60_000;
  await service.recordFailure({
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    capability: 'free_busy',
    error: Object.assign(new Error('provider'), { code: 'ignored' }),
  });
  const [row] = await service.list(TENANT_ID, INTEGRATION_ID);
  assert.equal(row.status, 'degraded');
  assert.equal(row.lastSuccessAt, '2026-08-25T18:00:00.000Z');
  assert.equal(row.lastCheckedAt, '2026-08-25T18:01:00.000Z');
});

test('tenant-admin connection health view exposes only bounded capability diagnostics', async () => {
  const connection = {
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    status: 'connected',
    placesPermission: 'granted',
    calendarsPermission: 'granted',
    lastVerifiedAt: '2026-08-25T18:00:00.000Z',
  };
  const view = createMicrosoft365ConnectionHealthView({
    connectionService: {
      async getConnection() {
        return {
          status: 'connected',
          placesPermission: 'granted',
          calendarsPermission: 'granted',
          reason: null,
          lastVerifiedAt: connection.lastVerifiedAt,
          requiredPermissions: ['Place.Read.All'],
        };
      },
    },
    connectionRepository: { async findByTenantId() { return connection; } },
    capabilityHealthService: {
      async list() {
        return [{
          capability: 'calendar_write',
          status: 'unavailable',
          reason: 'provider_unavailable',
          lastCheckedAt: '2026-08-25T18:02:00.000Z',
          lastSuccessAt: '2026-08-25T17:55:00.000Z',
        }];
      },
    },
  });
  const result = await view.getConnection({ tenantContext: { tenantId: TENANT_ID } });
  assert.equal(result.capabilities.places.status, 'healthy');
  assert.equal(result.capabilities.freeBusy.status, 'not_configured');
  assert.equal(result.capabilities.calendarWrite.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes(TENANT_ID), false);
  assert.equal(JSON.stringify(result).includes(INTEGRATION_ID), false);
});
