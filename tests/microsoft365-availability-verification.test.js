import assert from 'node:assert/strict';
import test from 'node:test';
import { createMicrosoft365AvailabilityVerificationService } from '../src/application/microsoft365-availability-verification-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
} from '../src/integrations/calendar-contract.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const CORRELATION = '44444444-4444-4444-8444-444444444444';
const INTEGRATION = '55555555-5555-4555-8555-555555555555';

function principal(tenantId = TENANT_A, roles = ['tenant_admin']) {
  const snapshot = tenantAuthorizationSnapshot(roles);
  return Object.freeze({
    tenantId,
    userId: USER_A,
    roles: snapshot.roles,
    permissions: snapshot.permissions,
  });
}

function service({ mappings, providerError, connectionStatus = 'connected' } = {}) {
  const calls = [];
  const auditDenials = [];
  const instance = createMicrosoft365AvailabilityVerificationService({
    mappingRepository: {
      async listByTenantIdAndIntegrationId(tenantId, integrationId) {
        calls.push({ operation: 'mappings', tenantId, integrationId });
        return mappings ?? [{ roomId: 'room-a', providerStatus: 'active' }];
      },
    },
    connectionRepository: {
      async findByTenantId(tenantId) {
        calls.push({ operation: 'connection', tenantId });
        return { integrationId: INTEGRATION, status: connectionStatus };
      },
    },
    calendarProviderFactory: {
      async forRoom(values) {
        calls.push({ operation: 'provider', ...values });
        return {
          async lookupAvailability(input) {
            calls.push({ operation: 'availability', ...input });
            if (providerError) throw providerError;
            return { available: true, conflictCount: 0 };
          },
        };
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      async recordAuthorizationDenied(values) { auditDenials.push(values); },
    },
    clock: () => Date.parse('2026-08-26T06:00:00.000Z'),
  });
  return { instance, calls, auditDenials };
}

test('Tenant Admin free-busy verification uses a server-selected active mapped room', async () => {
  const { instance, calls } = service();
  const result = await instance.verify({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A, status: 'onboarding' },
    correlationId: CORRELATION,
  });

  assert.deepEqual(result, { verified: true, checkedAt: '2026-08-26T06:00:00.000Z' });
  assert.deepEqual(calls[0], { operation: 'connection', tenantId: TENANT_A });
  assert.deepEqual(calls[1], { operation: 'mappings', tenantId: TENANT_A, integrationId: INTEGRATION });
  assert.deepEqual(calls[2], { operation: 'provider', tenantId: TENANT_A, roomId: 'room-a' });
  assert.equal(calls[3].tenantId, TENANT_A);
  assert.equal(calls[3].roomId, 'room-a');
  assert.equal(calls[3].startsAt, '2026-08-26T06:01:00.000Z');
  assert.equal(calls[3].endsAt, '2026-08-26T06:31:00.000Z');
});

test('Employee and cross-tenant principals cannot invoke free-busy verification', async () => {
  const employee = service();
  await assert.rejects(
    employee.instance.verify({
      principal: principal(TENANT_A, ['employee']),
      tenantContext: { tenantId: TENANT_A, status: 'onboarding' },
      correlationId: CORRELATION,
    }),
    (error) => error?.code === 'PERMISSION_REQUIRED',
  );
  assert.equal(employee.calls.length, 0);
  assert.equal(employee.auditDenials.length, 1);

  const crossTenant = service();
  await assert.rejects(
    crossTenant.instance.verify({
      principal: principal(TENANT_A),
      tenantContext: { tenantId: TENANT_B, status: 'onboarding' },
      correlationId: CORRELATION,
    }),
    (error) => error?.code === 'TENANT_SCOPE_MISMATCH',
  );
  assert.equal(crossTenant.calls.length, 0);
  assert.equal(crossTenant.auditDenials.length, 1);
});

test('verification fails closed without a connected integration or active room mapping', async () => {
  await assert.rejects(
    service({ connectionStatus: 'degraded' }).instance.verify({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A, status: 'onboarding' },
      correlationId: CORRELATION,
    }),
    (error) => error?.code === 'MICROSOFT365_CONNECTION_REQUIRED',
  );

  await assert.rejects(
    service({ mappings: [] }).instance.verify({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A, status: 'onboarding' },
      correlationId: CORRELATION,
    }),
    (error) => error?.code === 'MICROSOFT365_ROOM_MAPPING_REQUIRED',
  );
});

test('provider failures remain actionable without exposing provider payloads', async () => {
  const transient = new CalendarProviderError(PROVIDER_ERROR_KIND.THROTTLED, {
    operation: 'availability',
    retryAfterMs: 1000,
  });
  await assert.rejects(
    service({ providerError: transient }).instance.verify({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A, status: 'onboarding' },
      correlationId: CORRELATION,
    }),
    (error) => error?.code === 'MICROSOFT365_FREE_BUSY_VERIFICATION_UNAVAILABLE',
  );

  const authorization = new CalendarProviderError(PROVIDER_ERROR_KIND.AUTHORIZATION, {
    operation: 'availability',
  });
  await assert.rejects(
    service({ providerError: authorization }).instance.verify({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A, status: 'onboarding' },
      correlationId: CORRELATION,
    }),
    (error) => error?.code === 'MICROSOFT365_FREE_BUSY_VERIFICATION_NOT_READY',
  );
});
