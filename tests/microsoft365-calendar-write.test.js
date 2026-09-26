import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FinalRoomAvailabilityError,
  createFinalRoomConfirmationService,
} from '../src/application/final-room-confirmation-service.js';
import { createMicrosoft365BookingServiceFactory } from '../src/application/microsoft365-booking-service-factory.js';
import {
  RequestCancellationReconciliationError,
  createRequestService,
} from '../src/application/request-service.js';
import { asApiError } from '../src/api-error.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { RequestStateConflictError } from '../src/authorization/errors.js';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
} from '../src/integrations/calendar-contract.js';
import {
  Microsoft365ProviderError,
  createMicrosoft365Client,
} from '../src/integrations/microsoft365-client.js';
import { createMicrosoft365CalendarProviderFactory } from '../src/integrations/microsoft365-calendar-provider.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_TENANT = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const ACCESS_TOKEN = 'T'.repeat(128);
const ROOM_ADDRESS = 'room-a@example.com';
const EVENT_ID = 'event-123';
const IDEMPOTENCY_KEY = 'a'.repeat(64);

function jsonResponse(status, payload) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
  });
}

function client(fetchImpl) {
  return createMicrosoft365Client({
    clientId: CLIENT_ID,
    clientSecret: 'test-only-secret-not-production',
    publicOrigin: 'https://conference.example',
    fetchImpl,
    applicationFactory({ authority }) {
      assert.equal(authority, `https://login.microsoftonline.com/${PROVIDER_TENANT}`);
      return {
        async acquireTokenByClientCredential() {
          return { accessToken: ACCESS_TOKEN };
        },
      };
    },
  });
}

function request(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: 'request-a',
    requesterUserId: USER_ID,
    requesterAttribution: { displayName: 'Persisted requester' },
    version: 1,
    roomId: 'room-a',
    status: REQUEST_STATUS.IN_REVIEW,
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 0,
    statusChangedAt: '2026-08-25T16:00:00.000Z',
    createdAt: '2026-08-25T15:00:00.000Z',
    updatedAt: '2026-08-25T16:00:00.000Z',
    ...overrides,
  };
}

const principal = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  roles: ['conference_manager'],
  permissions: ['request:read', 'request:manage'],
};
const tenantContext = { tenantId: TENANT_ID, status: 'active' };

test('Microsoft Graph calendar create update and delete use fixed resource paths and minimized UTC payloads', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (options.method === 'POST') {
      return jsonResponse(201, { id: EVENT_ID, body: { content: 'ignored' } });
    }
    if (options.method === 'PATCH') {
      return jsonResponse(200, { id: EVENT_ID, subject: 'ignored' });
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error('unexpected method');
  });

  assert.deepEqual(await api.createCalendarEvent({
    tenantReference: PROVIDER_TENANT,
    resourceAddress: ROOM_ADDRESS,
    startsAt: '2026-09-01T10:00:00.123Z',
    endsAt: '2026-09-01T11:00:00.456Z',
    idempotencyKey: IDEMPOTENCY_KEY,
  }), { providerReference: EVENT_ID, disposition: 'created' });

  assert.deepEqual(await api.updateCalendarEvent({
    tenantReference: PROVIDER_TENANT,
    resourceAddress: ROOM_ADDRESS,
    providerReference: EVENT_ID,
    startsAt: '2026-09-01T11:00:00.234Z',
    endsAt: '2026-09-01T12:00:00.567Z',
  }), { providerReference: EVENT_ID, disposition: 'updated' });

  assert.deepEqual(await api.cancelCalendarEvent({
    tenantReference: PROVIDER_TENANT,
    resourceAddress: ROOM_ADDRESS,
    providerReference: EVENT_ID,
  }), { providerReference: EVENT_ID, disposition: 'cancelled' });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.origin, 'https://graph.microsoft.com');
  assert.equal(
    calls[0].url.pathname,
    '/v1.0/users/room-a%40example.com/calendar/events',
  );
  assert.equal(calls[0].options.redirect, 'error');
  const createdBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(
    Object.keys(createdBody).sort(),
    ['end', 'showAs', 'start', 'subject', 'transactionId'],
  );
  assert.equal(createdBody.subject, 'Conference Manager room reservation');
  assert.equal(createdBody.showAs, 'busy');
  assert.equal(createdBody.transactionId, IDEMPOTENCY_KEY);
  assert.deepEqual(
    createdBody.start,
    { dateTime: '2026-09-01T10:00:00.123', timeZone: 'UTC' },
  );
  assert.deepEqual(
    createdBody.end,
    { dateTime: '2026-09-01T11:00:00.456', timeZone: 'UTC' },
  );
  assert.equal(Object.hasOwn(createdBody, 'attendees'), false);
  assert.equal(Object.hasOwn(createdBody, 'body'), false);

  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(
    calls[1].url.pathname,
    '/v1.0/users/room-a%40example.com/events/event-123',
  );
  assert.equal(
    Object.hasOwn(JSON.parse(calls[1].options.body), 'transactionId'),
    false,
  );
  assert.deepEqual(JSON.parse(calls[1].options.body).start, {
    dateTime: '2026-09-01T11:00:00.234',
    timeZone: 'UTC',
  });
  assert.deepEqual(JSON.parse(calls[1].options.body).end, {
    dateTime: '2026-09-01T12:00:00.567',
    timeZone: 'UTC',
  });
  assert.equal(calls[2].options.method, 'DELETE');
  assert.equal(calls[2].options.body, undefined);
});

test('calendar write provider failures are stable and do not expose raw Graph payloads', async () => {
  const api = client(async () => jsonResponse(409, {
    error: { message: 'sensitive detail' },
  }));
  await assert.rejects(
    api.createCalendarEvent({
      tenantReference: PROVIDER_TENANT,
      resourceAddress: ROOM_ADDRESS,
      startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-09-01T11:00:00.000Z',
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_CALENDAR_CONFLICT'
      && !error.message.includes('sensitive detail'),
  );
});

test('calendar update and cancellation use the resource address bound at create, not a later room remapping', async () => {
  const calls = [];
  const remappedAddress = 'room-remapped@example.com';
  const providerClient = {
    async lookupFreeBusy() {
      return [{ schedule: remappedAddress, available: true, conflictCount: 0 }];
    },
    async createCalendarEvent(values) {
      calls.push(['create', values.resourceAddress]);
      return { providerReference: EVENT_ID, disposition: 'created' };
    },
    async updateCalendarEvent(values) {
      calls.push(['update', values.resourceAddress]);
      return { providerReference: values.providerReference, disposition: 'updated' };
    },
    async cancelCalendarEvent(values) {
      calls.push(['cancel', values.resourceAddress]);
      return { providerReference: values.providerReference, disposition: 'cancelled' };
    },
  };
  const factory = createMicrosoft365CalendarProviderFactory({
    connectionRepository: {
      async findByTenantId() {
        return {
          integrationId: CLIENT_ID,
          providerTenantReference: PROVIDER_TENANT,
          connectionVersion: 1,
          status: 'connected',
          calendarsPermission: 'granted',
        };
      },
    },
    bindingRepository: {
      async findActiveBindingByTenantId() {
        return {
          tenantId: TENANT_ID,
          provider: 'microsoft_entra',
          providerTenantReference: PROVIDER_TENANT,
          status: 'active',
        };
      },
    },
    mappingRepository: {
      async listByTenantIdAndIntegrationId() {
        return [{ roomId: 'room-a', resourceAddress: remappedAddress, providerStatus: 'active' }];
      },
    },
    providerClient,
  });
  const provider = await factory.forRoom({ tenantId: TENANT_ID, roomId: 'room-a' });
  const baseInput = {
    tenantId: TENANT_ID,
    requestId: 'request-a',
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    phase: 'final',
    correlationId: CORRELATION_ID,
  };

  assert.deepEqual(await provider.createCalendarEvent({
    ...baseInput,
    idempotencyKey: IDEMPOTENCY_KEY,
  }), {
    providerReference: EVENT_ID,
    providerResourceReference: remappedAddress,
    disposition: 'created',
  });
  assert.equal((await provider.createCalendarEvent({
    ...baseInput,
    idempotencyKey: IDEMPOTENCY_KEY,
    providerResourceReference: ROOM_ADDRESS,
  })).providerResourceReference, ROOM_ADDRESS);
  await provider.updateCalendarEvent({
    ...baseInput,
    providerReference: EVENT_ID,
    providerResourceReference: ROOM_ADDRESS,
  });
  await provider.cancelCalendarEvent({
    ...baseInput,
    providerReference: EVENT_ID,
    providerResourceReference: ROOM_ADDRESS,
  });

  assert.deepEqual(calls, [
    ['create', remappedAddress],
    ['create', ROOM_ADDRESS],
    ['update', ROOM_ADDRESS],
    ['cancel', ROOM_ADDRESS],
  ]);
});

test('calendar writes automatically retry bounded transient Graph failures', async () => {
  let attempts = 0;
  const providerClient = {
    async lookupFreeBusy() { return [{ schedule: ROOM_ADDRESS, available: true, conflictCount: 0 }]; },
    async createCalendarEvent() { return { providerReference: EVENT_ID, disposition: 'created' }; },
    async updateCalendarEvent(values) {
      attempts += 1;
      if (attempts < 3) throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
      return { providerReference: values.providerReference, disposition: 'updated' };
    },
    async cancelCalendarEvent() { return { providerReference: EVENT_ID, disposition: 'cancelled' }; },
  };
  const factory = createMicrosoft365CalendarProviderFactory({
    connectionRepository: { async findByTenantId() { return {
      integrationId: CLIENT_ID,
      providerTenantReference: PROVIDER_TENANT,
      connectionVersion: 1,
      status: 'connected',
      calendarsPermission: 'granted',
    }; } },
    bindingRepository: { async findActiveBindingByTenantId() { return {
      tenantId: TENANT_ID,
      provider: 'microsoft_entra',
      providerTenantReference: PROVIDER_TENANT,
      status: 'active',
    }; } },
    mappingRepository: { async listByTenantIdAndIntegrationId() { return [
      { roomId: 'room-a', resourceAddress: ROOM_ADDRESS, providerStatus: 'active' },
    ]; } },
    providerClient,
    retrySleep: async () => {},
  });
  const provider = await factory.forRoom({ tenantId: TENANT_ID, roomId: 'room-a' });
  await provider.updateCalendarEvent({
    tenantId: TENANT_ID,
    requestId: 'request-a',
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    phase: 'final',
    correlationId: CORRELATION_ID,
    providerReference: EVENT_ID,
    providerResourceReference: ROOM_ADDRESS,
  });
  assert.equal(attempts, 3);
});

test('persisted cleanup binding survives mapping and connection-health changes but rejects identity generation drift', async () => {
  for (const status of ['degraded', 'disconnected']) {
    const calls = [];
    const factory = createMicrosoft365CalendarProviderFactory({
      connectionRepository: {
        async findByTenantId() {
          return {
            tenantId: TENANT_ID,
            integrationId: CLIENT_ID,
            providerTenantReference: PROVIDER_TENANT,
            connectionVersion: 2,
            status,
            calendarsPermission: 'missing',
          };
        },
      },
      bindingRepository: {
        async findActiveBindingByTenantId() {
          return {
            tenantId: TENANT_ID,
            provider: 'microsoft_entra',
            providerTenantReference: PROVIDER_TENANT,
            status: 'active',
          };
        },
      },
      mappingRepository: {
        async listByTenantIdAndIntegrationId() {
          throw new Error('cleanup must not read current room mappings');
        },
      },
      providerClient: {
        async lookupFreeBusy() { throw new Error('UNREACHABLE'); },
        async cancelCalendarEvent(values) {
          calls.push(values);
          return { providerReference: EVENT_ID, disposition: 'cancelled' };
        },
      },
    });
    const provider = await factory.forPersistedReference({
      tenantId: TENANT_ID,
      roomId: 'room-a',
      integrationId: CLIENT_ID,
      providerConnectionReference: PROVIDER_TENANT,
      providerResourceReference: ROOM_ADDRESS,
    });
    assert.deepEqual(await provider.cancelCalendarEvent({
      tenantId: TENANT_ID,
      requestId: 'request-a',
      roomId: 'room-a',
      startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-09-01T11:00:00.000Z',
      phase: 'final',
      correlationId: CORRELATION_ID,
      providerReference: EVENT_ID,
      providerResourceReference: ROOM_ADDRESS,
    }), { providerReference: EVENT_ID, disposition: 'cancelled' });
    assert.equal(calls[0].tenantReference, PROVIDER_TENANT);
    assert.equal(calls[0].resourceAddress, ROOM_ADDRESS);
  }

  const reboundTenant = '66666666-6666-4666-8666-666666666666';
  const rebound = createMicrosoft365CalendarProviderFactory({
    connectionRepository: {
      async findByTenantId() {
        return {
          tenantId: TENANT_ID,
          integrationId: CLIENT_ID,
          providerTenantReference: reboundTenant,
          connectionVersion: 3,
          status: 'connected',
          calendarsPermission: 'granted',
        };
      },
    },
    bindingRepository: {
      async findActiveBindingByTenantId() {
        return {
          tenantId: TENANT_ID,
          provider: 'microsoft_entra',
          providerTenantReference: reboundTenant,
          status: 'active',
        };
      },
    },
    mappingRepository: { async listByTenantIdAndIntegrationId() { return []; } },
    providerClient: { async lookupFreeBusy() { return []; } },
  });
  await assert.rejects(
    rebound.forPersistedReference({
      tenantId: TENANT_ID,
      roomId: 'room-a',
      integrationId: CLIENT_ID,
      providerConnectionReference: PROVIDER_TENANT,
      providerResourceReference: ROOM_ADDRESS,
    }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.AUTHORIZATION,
  );
});

test('booking cancellation factory derives provider scope only from the persisted reference', async () => {
  const calls = [];
  const reference = {
    tenantId: TENANT_ID,
    requestId: 'request-a',
    integrationId: CLIENT_ID,
    providerReference: EVENT_ID,
    providerConnectionReference: PROVIDER_TENANT,
    providerResourceReference: ROOM_ADDRESS,
    idempotencyKey: IDEMPOTENCY_KEY,
    attemptNumber: 1,
    state: 'active',
  };
  const repository = {
    async hasProviderReferenceByRequest() { return true; },
    async findProviderReferenceForCancellation() { return reference; },
    async hasConflictingRequest() { return false; },
    async findProviderReferenceByRequest() { return reference; },
    async reserveProviderResourceBinding() { throw new Error('UNREACHABLE'); },
    async retryProviderResourceBinding() { throw new Error('UNREACHABLE'); },
    async createProviderReference() { throw new Error('UNREACHABLE'); },
    async touchProviderReference() { throw new Error('UNREACHABLE'); },
    async cancelProviderReference(values) {
      calls.push(['persist-cancel', values]);
      return { ...reference, state: 'cancelled' };
    },
    async beginCompensatingProviderReference() { throw new Error('UNREACHABLE'); },
    async completeCompensatingProviderReference() { throw new Error('UNREACHABLE'); },
  };
  const factory = createMicrosoft365BookingServiceFactory({
    repository,
    calendarProviderFactory: {
      async forRoom() { throw new Error('cleanup must not use the current room mapping'); },
      async forPersistedReference(values) {
        calls.push(['bind', values]);
        return {
          integrationId: CLIENT_ID,
          integrationProvider: 'microsoft365',
          identityProvider: 'microsoft_entra',
          providerConnectionReference: PROVIDER_TENANT,
          providerResourceReference: ROOM_ADDRESS,
          async lookupAvailability() { throw new Error('UNREACHABLE'); },
          async validateReservation() { throw new Error('UNREACHABLE'); },
          async createCalendarEvent() { throw new Error('UNREACHABLE'); },
          async updateCalendarEvent() { throw new Error('UNREACHABLE'); },
          async cancelCalendarEvent(input) {
            calls.push(['provider-cancel', input.providerResourceReference]);
            return { providerReference: EVENT_ID, disposition: 'cancelled' };
          },
        };
      },
    },
    entitlementService: {
      async requireAccess() { throw new Error('cleanup must bypass create entitlement'); },
    },
    auditService: {
      createEvent(values) { return values; },
      async record() {},
    },
    authorizationPolicy: {
      authorizeBookingOperation() { return true; },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });
  const cancelledRequest = request({ status: REQUEST_STATUS.CANCELLED });
  const service = await factory.forCancellation(cancelledRequest);
  assert.deepEqual(calls[0], ['bind', {
    tenantId: TENANT_ID,
    roomId: 'room-a',
    integrationId: CLIENT_ID,
    providerConnectionReference: PROVIDER_TENANT,
    providerResourceReference: ROOM_ADDRESS,
  }]);
  assert.deepEqual(await service.cancelCalendarEvent({
    principal,
    tenantContext,
    request: cancelledRequest,
    correlationId: CORRELATION_ID,
    phase: 'final',
  }), { disposition: 'cancelled', state: 'cancelled' });
  assert.deepEqual(calls.map(([operation]) => operation), [
    'bind',
    'provider-cancel',
    'persist-cancel',
  ]);
});

test('final confirmation creates calendar before local commit and compensates a losing local race', async () => {
  const calls = [];
  const loaded = request();
  const service = createFinalRoomConfirmationService({
    repository: {
      async withFinalConfirmationLock(_input, work) { return work(); },
      async findByTenantIdAndId() { return loaded; },
      async confirmIfRoomAvailable() {
        calls.push('commit');
        return { status: 'room_conflict', request: loaded };
      },
    },
    authorizationPolicy: {
      authorizeRequestRead() { return true; },
      authorizeRequestReconciliation() { return true; },
      authorizeRequestTransition() {
        return {
          transition: 'confirm',
          expectedStatus: REQUEST_STATUS.IN_REVIEW,
          nextStatus: REQUEST_STATUS.CONFIRMED,
          reason: null,
        };
      },
    },
    auditService: {
      createEvent(values) { return values; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    entitlementService: {
      async requireAccess() { return true; },
      async evaluateAccess() { return true; },
    },
    calendarProviderFactory: {
      async forRoom() {
        return {
          integrationId: CLIENT_ID,
          integrationProvider: 'microsoft365',
          identityProvider: 'microsoft_entra',
          providerConnectionReference: PROVIDER_TENANT,
          providerResourceReference: ROOM_ADDRESS,
          async validateReservation() {
            calls.push('validate');
            return { valid: true, reason: 'available' };
          },
        };
      },
    },
    bookingServiceFactory: {
      async forProvider() {
        return {
          async createCalendarEvent() {
            calls.push('create');
            return { disposition: 'created', state: 'active' };
          },
          async compensateCalendarEvent() {
            calls.push('cancel');
            return { disposition: 'cancelled', state: 'cancelled' };
          },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });

  await assert.rejects(
    service.confirm({
      principal,
      tenantContext,
      requestId: loaded.id,
      expectedVersion: loaded.version,
      correlationId: CORRELATION_ID,
    }),
    RequestStateConflictError,
  );
  assert.deepEqual(calls, ['validate', 'create', 'commit', 'cancel']);
});

test('failed compensation after an explicit local conflict surfaces a dedicated synchronization failure', async () => {
  const loaded = request();
  const service = createFinalRoomConfirmationService({
    repository: {
      async withFinalConfirmationLock(_input, work) { return work(); },
      async findByTenantIdAndId() { return loaded; },
      async confirmIfRoomAvailable() { return { status: 'room_conflict', request: loaded }; },
    },
    authorizationPolicy: {
      authorizeRequestRead() { return true; },
      authorizeRequestReconciliation() { return true; },
      authorizeRequestTransition() {
        return {
          transition: 'confirm',
          expectedStatus: REQUEST_STATUS.IN_REVIEW,
          nextStatus: REQUEST_STATUS.CONFIRMED,
          reason: null,
        };
      },
    },
    auditService: {
      createEvent(values) { return values; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    entitlementService: {
      async requireAccess() { return true; },
      async evaluateAccess() { return true; },
    },
    calendarProviderFactory: {
      async forRoom() {
        return {
          integrationId: CLIENT_ID,
          integrationProvider: 'microsoft365',
          identityProvider: 'microsoft_entra',
          providerConnectionReference: PROVIDER_TENANT,
          providerResourceReference: ROOM_ADDRESS,
          async validateReservation() {
            return { valid: true, reason: 'available' };
          },
        };
      },
    },
    bookingServiceFactory: {
      async forProvider() {
        return {
          async createCalendarEvent() {},
          async compensateCalendarEvent() {
            throw new Error('provider compensation failure');
          },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });
  await assert.rejects(
    service.confirm({
      principal,
      tenantContext,
      requestId: loaded.id,
      expectedVersion: loaded.version,
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof FinalRoomAvailabilityError
      && error.code === 'FINAL_ROOM_COMPENSATION_FAILED',
  );
});

test('final confirmation remains available when calendar write is disabled', async () => {
  const calls = [];
  const loaded = request();
  const confirmed = request({ status: REQUEST_STATUS.CONFIRMED, version: 2 });
  const service = createFinalRoomConfirmationService({
    repository: {
      async withFinalConfirmationLock(_input, work) { return work(); },
      async findByTenantIdAndId() { return loaded; },
      async confirmIfRoomAvailable() {
        calls.push('commit');
        return { status: 'confirmed', request: confirmed };
      },
    },
    authorizationPolicy: {
      authorizeRequestRead() { return true; },
      authorizeRequestReconciliation() { return true; },
      authorizeRequestTransition() {
        return {
          transition: 'confirm',
          expectedStatus: REQUEST_STATUS.IN_REVIEW,
          nextStatus: REQUEST_STATUS.CONFIRMED,
          reason: null,
        };
      },
    },
    auditService: {
      createEvent(values) { return values; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    entitlementService: {
      async requireAccess() { return true; },
      async evaluateAccess({ capabilityId }) {
        calls.push(`gate:${capabilityId}`);
        return false;
      },
    },
    calendarProviderFactory: {
      async forRoom() {
        return {
          integrationId: CLIENT_ID,
          integrationProvider: 'microsoft365',
          identityProvider: 'microsoft_entra',
          providerConnectionReference: PROVIDER_TENANT,
          providerResourceReference: ROOM_ADDRESS,
          async validateReservation() {
            calls.push('validate');
            return { valid: true, reason: 'available' };
          },
        };
      },
    },
    bookingServiceFactory: {
      async requiresCancellation() { return false; },
      async forCancellation() { throw new Error('UNREACHABLE'); },
      async forProvider() {
        throw new Error('calendar write factory must not run while disabled');
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });

  assert.equal(await service.confirm({
    principal,
    tenantContext,
    requestId: loaded.id,
    expectedVersion: loaded.version,
    correlationId: CORRELATION_ID,
  }), confirmed);
  assert.deepEqual(calls, [
    'gate:microsoft.calendar.write',
    'validate',
    'commit',
  ]);
});

test('cancellation without a persisted calendar reference avoids provider initialization', async () => {
  const calls = [];
  let current = request({ status: REQUEST_STATUS.CONFIRMED });
  const service = createRequestService({
    repository: {
      async findByTenantIdAndId() { return current; },
      async transitionByTenantIdAndId() {
        calls.push('commit');
        current = request({ status: REQUEST_STATUS.CANCELLED });
        return current;
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      createEvent(values) { return values; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    finalRoomConfirmationService: {
      async confirm() {
        throw new Error('FINAL_CONFIRMATION_NOT_EXPECTED');
      },
    },
    bookingServiceFactory: {
      async requiresCancellation() {
        calls.push('reference-check');
        return false;
      },
      async forCancellation() {
        throw new Error('calendar write factory must not run without a reference');
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });
  const employeePrincipal = {
    ...principal,
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  };

  const cancelled = await service.transitionRequest({
    principal: employeePrincipal,
    tenantContext,
    requestId: current.id,
    transition: 'cancel',
    expectedVersion: current.version,
    correlationId: CORRELATION_ID,
  });

  assert.equal(cancelled.status, REQUEST_STATUS.CANCELLED);
  assert.deepEqual(calls, ['reference-check', 'commit', 'reference-check']);
});

test('cancellation rechecks for a reference created concurrently with the local transition', async () => {
  let current = request({ status: REQUEST_STATUS.CONFIRMED });
  let checks = 0;
  let cancels = 0;
  const service = createRequestService({
    repository: {
      async findByTenantIdAndId() { return current; },
      async transitionByTenantIdAndId() {
        current = request({ status: REQUEST_STATUS.CANCELLED });
        return current;
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      createEvent(values) { return values; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    finalRoomConfirmationService: { async confirm() { throw new Error('UNREACHABLE'); } },
    bookingServiceFactory: {
      async requiresCancellation() {
        checks += 1;
        return checks === 2;
      },
      async forCancellation() {
        return {
          async cancelCalendarEvent() {
            cancels += 1;
            return { disposition: 'cancelled', state: 'cancelled' };
          },
        };
      },
    },
  });
  const employeePrincipal = {
    ...principal,
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  };

  assert.equal((await service.transitionRequest({
    principal: employeePrincipal,
    tenantContext,
    requestId: current.id,
    transition: 'cancel',
    expectedVersion: current.version,
    correlationId: CORRELATION_ID,
  })).status, REQUEST_STATUS.CANCELLED);
  assert.equal(checks, 2);
  assert.equal(cancels, 1);
});

test('calendar cancellation factory failures expose explicit retryable reconciliation after local commit', async () => {
  let current = request({ status: REQUEST_STATUS.CONFIRMED });
  let factoryAttempts = 0;
  let providerCancels = 0;
  const auditEvents = [];
  const metricEvents = [];
  const service = createRequestService({
    repository: {
      async findByTenantIdAndId() { return current; },
      async transitionByTenantIdAndId() {
        current = request({ status: REQUEST_STATUS.CANCELLED });
        return current;
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      createEvent(values) { return values; },
      async record(values) { auditEvents.push(values); },
      async recordAuthorizationDenied() {},
    },
    finalRoomConfirmationService: {
      async confirm() {
        throw new Error('FINAL_CONFIRMATION_NOT_EXPECTED');
      },
    },
    bookingServiceFactory: {
      async requiresCancellation() { return true; },
      async forCancellation() {
        factoryAttempts += 1;
        if (factoryAttempts === 1) {
          throw new CalendarProviderError(PROVIDER_ERROR_KIND.UNAVAILABLE, { operation: 'cancel' });
        }
        return {
          async cancelCalendarEvent() {
            providerCancels += 1;
            return { disposition: 'cancelled', state: 'cancelled' };
          },
        };
      },
    },
    metrics: {
      recordBookingOperation(values) { metricEvents.push(values); },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });
  const employeePrincipal = {
    ...principal,
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  };
  const expectedVersion = current.version;

  let reconciliationError;
  try {
    await service.transitionRequest({
      principal: employeePrincipal,
      tenantContext,
      requestId: current.id,
      transition: 'cancel',
      expectedVersion,
      correlationId: CORRELATION_ID,
    });
  } catch (error) {
    reconciliationError = error;
  }
  assert.equal(reconciliationError instanceof RequestCancellationReconciliationError, true);
  assert.equal(current.status, REQUEST_STATUS.CANCELLED);
  const apiError = asApiError(reconciliationError);
  assert.equal(apiError.statusCode, 503);
  assert.equal(apiError.code, 'CALENDAR_RECONCILIATION_REQUIRED');
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].action, 'calendar.operation');
  assert.deepEqual(auditEvents[0].metadata, {
    operation: 'cancel',
    reasonCode: 'cancellation_factory_unavailable',
  });
  assert.deepEqual(metricEvents, [{ operation: 'cancel', outcome: 'failure' }]);

  assert.equal((await service.transitionRequest({
    principal: employeePrincipal,
    tenantContext,
    requestId: current.id,
    transition: 'cancel',
    expectedVersion,
    correlationId: CORRELATION_ID,
  })).status, REQUEST_STATUS.CANCELLED);
  assert.equal(providerCancels, 1);
});

test('calendar reference lookup failures are observable and remain retryable before local commit', async () => {
  const loaded = request({ status: REQUEST_STATUS.CONFIRMED });
  const auditEvents = [];
  const metricEvents = [];
  let commits = 0;
  const service = createRequestService({
    repository: {
      async findByTenantIdAndId() { return loaded; },
      async transitionByTenantIdAndId() {
        commits += 1;
        return request({ status: REQUEST_STATUS.CANCELLED });
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      createEvent(values) { return values; },
      async record(values) { auditEvents.push(values); },
      async recordAuthorizationDenied() {},
    },
    finalRoomConfirmationService: { async confirm() { throw new Error('UNREACHABLE'); } },
    bookingServiceFactory: {
      async requiresCancellation() { throw new Error('database unavailable'); },
      async forCancellation() { throw new Error('UNREACHABLE'); },
    },
    metrics: {
      recordBookingOperation(values) { metricEvents.push(values); },
    },
  });
  const employeePrincipal = {
    ...principal,
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  };

  await assert.rejects(
    service.transitionRequest({
      principal: employeePrincipal,
      tenantContext,
      requestId: loaded.id,
      transition: 'cancel',
      expectedVersion: loaded.version,
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof RequestCancellationReconciliationError,
  );
  assert.equal(commits, 0);
  assert.equal(auditEvents.length, 1);
  assert.deepEqual(auditEvents[0].metadata, {
    operation: 'cancel',
    reasonCode: 'reference_lookup_unavailable',
  });
  assert.deepEqual(metricEvents, [{ operation: 'cancel', outcome: 'failure' }]);
});

test('reject and request-change transitions clean retained calendar references and support reconciliation retry', async () => {
  for (const [transition, expectedStatus] of [
    ['reject', REQUEST_STATUS.REJECTED],
    ['request_change', REQUEST_STATUS.CHANGE_REQUESTED],
  ]) {
    let current = request({ status: REQUEST_STATUS.IN_REVIEW });
    let cancellationAttempts = 0;
    const service = createRequestService({
      repository: {
        async findByTenantIdAndId() { return current; },
        async transitionByTenantIdAndId({ nextStatus, reason }) {
          current = request({ status: nextStatus, statusReason: reason });
          return current;
        },
      },
      authorizationPolicy: createAuthorizationPolicy(),
      auditService: {
        createEvent(values) { return values; },
        async record() {},
        async recordAuthorizationDenied() {},
      },
      finalRoomConfirmationService: { async confirm() { throw new Error('UNREACHABLE'); } },
      bookingServiceFactory: {
        async requiresCancellation() { return true; },
        async forCancellation() {
          return {
            async cancelCalendarEvent() {
              cancellationAttempts += 1;
              if (cancellationAttempts === 1) throw new Error('PROVIDER_DELETE_UNAVAILABLE');
              return { disposition: 'cancelled', state: 'cancelled' };
            },
          };
        },
      },
    });
    const input = {
      principal,
      tenantContext,
      requestId: current.id,
      transition,
      reason: 'not approved',
      expectedVersion: current.version,
      correlationId: CORRELATION_ID,
    };
    await assert.rejects(
      service.transitionRequest(input),
      RequestCancellationReconciliationError,
    );
    assert.equal(current.status, expectedStatus);
    assert.equal((await service.transitionRequest(input)).status, expectedStatus);
    assert.equal(cancellationAttempts, 2);
  }
});

test('request cancellation retry skips provider initialization after the reference is terminal', async () => {
  let current = request({ status: REQUEST_STATUS.CONFIRMED });
  let cancels = 0;
  let cleanupRequired = true;
  const service = createRequestService({
    repository: {
      async findByTenantIdAndId() { return current; },
      async transitionByTenantIdAndId() {
        current = request({ status: REQUEST_STATUS.CANCELLED });
        return current;
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      createEvent(values) { return values; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    finalRoomConfirmationService: {
      async confirm() {
        throw new Error('FINAL_CONFIRMATION_NOT_EXPECTED');
      },
    },
    bookingServiceFactory: {
      async requiresCancellation() { return cleanupRequired; },
      async forCancellation() {
        return {
          async cancelCalendarEvent() {
            cancels += 1;
            cleanupRequired = false;
            return { disposition: 'cancelled', state: 'cancelled' };
          },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });
  const employeePrincipal = {
    ...principal,
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  };
  const expectedVersion = current.version;

  await service.transitionRequest({
    principal: employeePrincipal,
    tenantContext,
    requestId: current.id,
    transition: 'cancel',
    expectedVersion,
    correlationId: CORRELATION_ID,
  });
  await service.transitionRequest({
    principal: employeePrincipal,
    tenantContext,
    requestId: current.id,
    transition: 'cancel',
    expectedVersion,
    correlationId: CORRELATION_ID,
  });
  assert.equal(cancels, 1);
});
