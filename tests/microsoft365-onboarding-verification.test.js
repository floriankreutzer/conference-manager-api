import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMicrosoft365OnboardingVerificationService,
} from '../src/application/microsoft365-onboarding-verification-service.js';
import {
  createMicrosoft365RoomMappingService,
} from '../src/application/microsoft365-room-mapping-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { CalendarProviderError, PROVIDER_ERROR_KIND } from '../src/integrations/calendar-contract.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444';
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

function mappingRecord(overrides = {}) {
  return Object.freeze({
    roomId: ROOM_ID,
    externalRoomId: 'provider-room-01',
    resourceAddress: 'room-berlin-01@example.invalid',
    providerDisplayName: 'Berlin Room 01',
    providerCapacity: 12,
    providerStatus: 'active',
    lastSeenAt: '2026-08-26T07:55:00.000Z',
    localRoom: Object.freeze({
      id: ROOM_ID,
      siteId: 'berlin',
      name: 'Berlin Room 01',
      capacity: 12,
      active: true,
    }),
    ...overrides,
  });
}

function fixture({ mappings, lookupAvailability } = {}) {
  const observed = [];
  const auditDenials = [];
  const roomMappingService = createMicrosoft365RoomMappingService({
    mappingRepository: {
      async listByTenantIdAndIntegrationId(tenantId, integrationId) {
        observed.push({ type: 'mapping', values: { tenantId, integrationId } });
        return mappings ?? [mappingRecord()];
      },
      async existingSiteIds() { throw new Error('NOT_USED'); },
      async importRooms() { throw new Error('NOT_USED'); },
      async synchronize() { throw new Error('NOT_USED'); },
    },
    connectionRepository: {
      async findByTenantId(tenantId) {
        observed.push({ type: 'connection', values: { tenantId } });
        return {
          integrationId: INTEGRATION_ID,
          status: 'connected',
          placesPermission: 'granted',
        };
      },
    },
    discoveryService: {
      async discoverRooms() { throw new Error('NOT_USED'); },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      createEvent(value) { return value; },
      async recordAuthorizationDenied(values) { auditDenials.push(values); },
    },
  });
  const service = createMicrosoft365OnboardingVerificationService({
    roomMappingService,
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
    clock: () => NOW,
  });
  return { service, observed, auditDenials };
}

const tenantContext = Object.freeze({ tenantId: TENANT_ID, status: 'onboarding' });

test('Tenant Admin free-busy verification uses a server-derived mapped room and time window', async () => {
  const { service, observed } = fixture();
  const result = await service.verifyFreeBusy({
    principal: principal(['tenant_admin']),
    tenantContext,
    correlationId: CORRELATION_ID,
  });

  assert.deepEqual(result, { verified: true, checkedAt: '2026-08-26T08:00:00.000Z' });
  assert.deepEqual(observed[0], {
    type: 'connection',
    values: { tenantId: TENANT_ID },
  });
  assert.deepEqual(observed[1], {
    type: 'mapping',
    values: { tenantId: TENANT_ID, integrationId: INTEGRATION_ID },
  });
  assert.deepEqual(observed[2], {
    type: 'provider',
    values: { tenantId: TENANT_ID, roomId: ROOM_ID },
  });
  assert.deepEqual(observed[3], {
    type: 'availability',
    values: {
      tenantId: TENANT_ID,
      roomId: ROOM_ID,
      startsAt: '2026-08-26T08:05:00.000Z',
      endsAt: '2026-08-26T08:35:00.000Z',
    },
  });
});

test('Employee denial is audited once before connection, mapping or provider work', async () => {
  const { service, observed, auditDenials } = fixture();
  await assert.rejects(
    service.verifyFreeBusy({
      principal: principal(['employee']),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'PERMISSION_REQUIRED',
  );
  assert.equal(observed.length, 0);
  assert.equal(auditDenials.length, 1);
  assert.equal(auditDenials[0].tenantContext.tenantId, TENANT_ID);
  assert.equal(auditDenials[0].metadata.operation, 'room_mapping_list');
});

test('mismatched Tenant context fails closed without creating a foreign Tenant audit event', async () => {
  const { service, observed, auditDenials } = fixture();
  await assert.rejects(
    service.verifyFreeBusy({
      principal: principal(['tenant_admin']),
      tenantContext: { tenantId: OTHER_TENANT_ID, status: 'onboarding' },
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'TENANT_SCOPE_INVALID',
  );
  assert.equal(observed.length, 0);
  assert.equal(auditDenials.length, 0);
});

test('verification fails closed when no active imported room exists', async () => {
  const { service, observed } = fixture({
    mappings: [mappingRecord({ providerStatus: 'removed' })],
  });
  await assert.rejects(
    service.verifyFreeBusy({
      principal: principal(['tenant_admin']),
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'MICROSOFT365_ROOM_MAPPING_REQUIRED',
  );
  assert.equal(observed.some((entry) => entry.type === 'provider'), false);
  assert.equal(observed.some((entry) => entry.type === 'availability'), false);
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
