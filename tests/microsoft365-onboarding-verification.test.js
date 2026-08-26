import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMicrosoft365OnboardingVerificationService,
} from '../src/application/microsoft365-onboarding-verification-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { CalendarProviderError, PROVIDER_ERROR_KIND } from '../src/integrations/calendar-contract.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = 'room-berlin-01';
const NOW = Date.parse('2026-08-26T08:00:00.000Z');

function principal(roles, tenantId = TENANT_ID) {
  const snapshot = tenantAuthorizationSnapshot(roles);
  return Object.freeze({
    tenantId,
    userId: USER_ID,
    roles: snapshot.roles,
    permissions: snapshot.permissions,
  });
}

function fixture({ mappings, lookupAvailability } = {}) {
  const observed = [];
  const service = createMicrosoft365OnboardingVerificationService({
    roomMappingService: {
      async listMappings(values) {
        observed.push({ type: 'mapping', values });
        return mappings ?? [{ roomId: ROOM_ID, providerStatus: 'active' }];
      },
    },
    calendarProviderFactory: {
      async forRoom(values) {
        observed.push({ type: 'provider', values });
        return {
          async lookupAvailability(values) {
            observed.push({ type: 'availability', values });
            if (lookupAvailability) return lookupAvailability(values);
            return { available: true, conflictCount: 0 };
          },
        };
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    clock: () => NOW,
  });
  return { service, observed };
}

const tenantContext = Object.freeze({ tenantId: TENANT_ID, status: 'onboarding' });

test('Tenant Admin free-busy verification uses a server-derived mapped room and time window', async () => {
  const { service, observed } = fixture();
  const result = await service.verifyFreeBusy({
    principal: principal(['tenant_admin']),
    tenantContext,
    correlationId: CORRELATION_ID,
  });

  assert.deepEqual(result, { verified: true });
  assert.deepEqual(observed[1], {
    type: 'provider',
    values: { tenantId: TENANT_ID, roomId: ROOM_ID },
  });
  assert.deepEqual(observed[2], {
    type: 'availability',
    values: {
      tenantId: TENANT_ID,
      roomId: ROOM_ID,
      startsAt: '2026-08-26T08:05:00.000Z',
      endsAt: '2026-08-26T08:35:00.000Z',
    },
  });
});

test('Employee and mismatched Tenant context cannot run onboarding verification', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.verifyFreeBusy({
      principal: principal(['employee']),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'PERMISSION_REQUIRED',
  );
  await assert.rejects(
    service.verifyFreeBusy({
      principal: principal(['tenant_admin']),
      tenantContext: { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'onboarding' },
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'TENANT_SCOPE_INVALID',
  );
});

test('verification fails closed when no active imported room exists', async () => {
  const { service } = fixture({ mappings: [{ roomId: ROOM_ID, providerStatus: 'removed' }] });
  await assert.rejects(
    service.verifyFreeBusy({
      principal: principal(['tenant_admin']),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'MICROSOFT365_ROOM_MAPPING_REQUIRED',
  );
});

test('provider authorization and transient failures are exposed as bounded connection errors', async () => {
  const blocked = fixture({
    lookupAvailability() {
      throw new CalendarProviderError(PROVIDER_ERROR_KIND.AUTHORIZATION, { operation: 'availability' });
    },
  }).service;
  await assert.rejects(
    blocked.verifyFreeBusy({
      principal: principal(['tenant_admin']),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'MICROSOFT365_FREE_BUSY_VERIFICATION_BLOCKED',
  );

  const unavailable = fixture({
    lookupAvailability() {
      throw new CalendarProviderError(PROVIDER_ERROR_KIND.UNAVAILABLE, { operation: 'availability' });
    },
  }).service;
  await assert.rejects(
    unavailable.verifyFreeBusy({
      principal: principal(['tenant_admin']),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'MICROSOFT365_FREE_BUSY_VERIFICATION_UNAVAILABLE',
  );
});
