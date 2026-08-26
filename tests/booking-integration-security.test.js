import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookingIntegrationService } from '../src/application/booking-integration-service.js';
import { CAPABILITY } from '../src/entitlements/capabilities.js';
import { EntitlementDeniedError } from '../src/entitlements/errors.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
  RESERVATION_PHASE,
  assertCalendarProvider,
  classifyProviderError,
} from '../src/integrations/calendar-contract.js';

const TENANT_ID = 'a1111111-1111-4111-8111-111111111111';
const USER_ID = 'a2222222-2222-4222-8222-222222222222';
const INTEGRATION_ID = 'a3333333-3333-4333-8333-333333333333';
const CORRELATION_ID = 'a4444444-4444-4444-8444-444444444444';

function operationContext() {
  return {
    principal: {
      tenantId: TENANT_ID,
      userId: USER_ID,
      roles: ['conference_manager'],
      permissions: ['request:read', 'request:manage'],
    },
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    request: {
      tenantId: TENANT_ID,
      id: 'request-security',
      requesterUserId: USER_ID,
      roomId: 'room-1',
      status: 'Submitted',
      statusReason: null,
      startsAt: '2026-09-01T12:00:00.000Z',
      endsAt: '2026-09-01T13:00:00.000Z',
      internalParticipants: 1,
      externalParticipants: 0,
      statusChangedAt: '2026-08-24T09:00:00.000Z',
      createdAt: '2026-08-24T09:00:00.000Z',
      updatedAt: '2026-08-24T09:00:00.000Z',
    },
    correlationId: CORRELATION_ID,
    phase: RESERVATION_PHASE.PROVISIONAL,
  };
}

function repository() {
  return {
    async hasConflictingRequest() { return false; },
    async findProviderReferenceByRequest() { return null; },
    async reserveProviderResourceBinding() { throw new Error('UNEXPECTED_PERSISTENCE_CALL'); },
    async retryProviderResourceBinding() { throw new Error('UNEXPECTED_PERSISTENCE_CALL'); },
    async createProviderReference() { throw new Error('UNEXPECTED_PERSISTENCE_CALL'); },
    async touchProviderReference() { throw new Error('UNEXPECTED_PERSISTENCE_CALL'); },
    async cancelProviderReference() { throw new Error('UNEXPECTED_PERSISTENCE_CALL'); },
    async beginCompensatingProviderReference() { throw new Error('UNEXPECTED_PERSISTENCE_CALL'); },
    async completeCompensatingProviderReference() { throw new Error('UNEXPECTED_PERSISTENCE_CALL'); },
  };
}

function auditService() {
  return {
    createEvent(values) { return values; },
    async record(values) { return values; },
  };
}

test('missing tenant entitlement short-circuits the provider even after business authorization', async () => {
  let providerCalls = 0;
  const service = createBookingIntegrationService({
    repository: repository(),
    provider: {
      integrationId: INTEGRATION_ID,
      providerConnectionReference: 'provider-tenant-a',
      providerResourceReference: 'room-1@example.invalid',
      async lookupAvailability() {
        providerCalls += 1;
        return { available: true, conflictCount: 0 };
      },
      async validateReservation() {
        providerCalls += 1;
        return { valid: true, reason: 'available' };
      },
      async createCalendarEvent() {
        providerCalls += 1;
        return {
          providerReference: 'event-1',
          providerResourceReference: 'room-1@example.invalid',
          disposition: 'created',
        };
      },
      async updateCalendarEvent() {
        providerCalls += 1;
        return { providerReference: 'event-1', disposition: 'updated' };
      },
      async cancelCalendarEvent() {
        providerCalls += 1;
        return { providerReference: 'event-1', disposition: 'cancelled' };
      },
    },
    entitlementService: {
      async requireAccess() {
        throw new EntitlementDeniedError();
      },
    },
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
    auditService: auditService(),
    authorizeOperation: async () => true,
  });

  await assert.rejects(service.lookupAvailability(operationContext()), EntitlementDeniedError);
  assert.equal(providerCalls, 0);
});

test('duplicate, conflict, and unknown provider failures are not blindly retryable', () => {
  for (const kind of [PROVIDER_ERROR_KIND.DUPLICATE, PROVIDER_ERROR_KIND.CONFLICT]) {
    const classification = classifyProviderError(
      new CalendarProviderError(kind, { operation: 'create' }),
      'create',
    );
    assert.equal(classification.retryable, false);
  }
  const unknown = classifyProviderError(new Error('provider internal detail'), 'create');
  assert.equal(unknown.kind, PROVIDER_ERROR_KIND.UNKNOWN);
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.code, 'CALENDAR_PROVIDER_FAILED');
});

test('calendar adapters must expose a bounded create-time provider resource binding', () => {
  const provider = {
    integrationId: INTEGRATION_ID,
    providerConnectionReference: 'provider-tenant-a',
    async lookupAvailability() {},
    async validateReservation() {},
    async createCalendarEvent() {},
    async updateCalendarEvent() {},
    async cancelCalendarEvent() {},
  };
  assert.throws(
    () => assertCalendarProvider(provider),
    /CALENDAR_PROVIDER_RESOURCE_REFERENCE_INVALID/,
  );
  assert.throws(
    () => assertCalendarProvider({ ...provider, providerResourceReference: ' invalid ' }),
    /CALENDAR_PROVIDER_RESOURCE_REFERENCE_INVALID/,
  );
  assert.equal(
    assertCalendarProvider({
      ...provider,
      providerConnectionReference: 'provider-tenant-a',
      providerResourceReference: 'room-1@example.invalid',
    })
      .providerResourceReference,
    'room-1@example.invalid',
  );
});
