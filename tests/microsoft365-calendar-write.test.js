import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinalRoomConfirmationService, FinalRoomAvailabilityError } from '../src/application/final-room-confirmation-service.js';
import { createRequestService } from '../src/application/request-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { RequestStateConflictError } from '../src/authorization/errors.js';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import { createMicrosoft365Client, Microsoft365ProviderError } from '../src/integrations/microsoft365-client.js';

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
    if (options.method === 'POST') return jsonResponse(201, { id: EVENT_ID, body: { content: 'ignored' } });
    if (options.method === 'PATCH') return jsonResponse(200, { id: EVENT_ID, subject: 'ignored' });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error('unexpected method');
  });

  assert.deepEqual(await api.createCalendarEvent({
    tenantReference: PROVIDER_TENANT,
    resourceAddress: ROOM_ADDRESS,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    idempotencyKey: IDEMPOTENCY_KEY,
  }), { providerReference: EVENT_ID, disposition: 'created' });

  assert.deepEqual(await api.updateCalendarEvent({
    tenantReference: PROVIDER_TENANT,
    resourceAddress: ROOM_ADDRESS,
    providerReference: EVENT_ID,
    startsAt: '2026-09-01T11:00:00.000Z',
    endsAt: '2026-09-01T12:00:00.000Z',
  }), { providerReference: EVENT_ID, disposition: 'updated' });

  assert.deepEqual(await api.cancelCalendarEvent({
    tenantReference: PROVIDER_TENANT,
    resourceAddress: ROOM_ADDRESS,
    providerReference: EVENT_ID,
  }), { providerReference: EVENT_ID, disposition: 'cancelled' });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.origin, 'https://graph.microsoft.com');
  assert.equal(calls[0].url.pathname, '/v1.0/users/room-a%40example.com/calendar/events');
  assert.equal(calls[0].options.redirect, 'error');
  const createdBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(createdBody).sort(), ['end', 'showAs', 'start', 'subject', 'transactionId']);
  assert.equal(createdBody.subject, 'Conference Manager room reservation');
  assert.equal(createdBody.showAs, 'busy');
  assert.equal(createdBody.transactionId, IDEMPOTENCY_KEY);
  assert.deepEqual(createdBody.start, { dateTime: '2026-09-01T10:00:00', timeZone: 'UTC' });
  assert.deepEqual(createdBody.end, { dateTime: '2026-09-01T11:00:00', timeZone: 'UTC' });
  assert.equal(Object.hasOwn(createdBody, 'attendees'), false);
  assert.equal(Object.hasOwn(createdBody, 'body'), false);

  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(calls[1].url.pathname, '/v1.0/users/room-a%40example.com/events/event-123');
  assert.equal(Object.hasOwn(JSON.parse(calls[1].options.body), 'transactionId'), false);
  assert.equal(calls[2].options.method, 'DELETE');
  assert.equal(calls[2].options.body, undefined);
});

test('calendar write provider failures are stable and do not expose raw Graph payloads', async () => {
  const api = client(async () => jsonResponse(409, { error: { message: 'sensitive detail' } }));
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

test('final confirmation creates calendar before local commit and compensates a losing local race', async () => {
  const calls = [];
  const loaded = request();
  const service = createFinalRoomConfirmationService({
    repository: {
      async findByTenantIdAndId() { return loaded; },
      async confirmIfRoomAvailable() {
        calls.push('commit');
        return { status: 'room_conflict', request: loaded };
      },
    },
    authorizationPolicy: {
      authorizeRequestRead() { return true; },
      authorizeRequestTransition() {
        return { transition: 'confirm', expectedStatus: REQUEST_STATUS.IN_REVIEW, nextStatus: REQUEST_STATUS.CONFIRMED, reason: null };
      },
    },
    auditService: {
      createEvent(values) { return values; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    entitlementService: { async requireAccess() { return true; } },
    calendarProviderFactory: {
      async forRoom() {
        return { async validateReservation() { calls.push('validate'); return { valid: true, reason: 'available' }; } };
      },
    },
    bookingServiceFactory: {
      async forRequest() {
        return {
          async createCalendarEvent() { calls.push('create'); return { disposition: 'created', state: 'active' }; },
          async cancelCalendarEvent() { calls.push('cancel'); return { disposition: 'cancelled', state: 'cancelled' }; },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });

  await assert.rejects(
    service.confirm({ principal, tenantContext, requestId: loaded.id, correlationId: CORRELATION_ID }),
    RequestStateConflictError,
  );
  assert.deepEqual(calls, ['validate', 'create', 'commit', 'cancel']);
});

test('failed compensation surfaces a dedicated synchronization failure', async () => {
  const loaded = request();
  const service = createFinalRoomConfirmationService({
    repository: {
      async findByTenantIdAndId() { return loaded; },
      async confirmIfRoomAvailable() { throw new Error('database failure'); },
    },
    authorizationPolicy: {
      authorizeRequestRead() { return true; },
      authorizeRequestTransition() {
        return { transition: 'confirm', expectedStatus: REQUEST_STATUS.IN_REVIEW, nextStatus: REQUEST_STATUS.CONFIRMED, reason: null };
      },
    },
    auditService: { createEvent(v) { return v; }, async record() {}, async recordAuthorizationDenied() {} },
    entitlementService: { async requireAccess() { return true; } },
    calendarProviderFactory: { async forRoom() { return { async validateReservation() { return { valid: true, reason: 'available' }; } }; } },
    bookingServiceFactory: {
      async forRequest() {
        return {
          async createCalendarEvent() {},
          async cancelCalendarEvent() { throw new Error('provider compensation failure'); },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });
  await assert.rejects(
    service.confirm({ principal, tenantContext, requestId: loaded.id, correlationId: CORRELATION_ID }),
    (error) => error instanceof FinalRoomAvailabilityError && error.code === 'FINAL_ROOM_COMPENSATION_FAILED',
  );
});

test('request cancellation retries external reconciliation after local cancellation already committed', async () => {
  let current = request({ status: REQUEST_STATUS.CONFIRMED });
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
    auditService: { createEvent(v) { return v; }, async record() {}, async recordAuthorizationDenied() {} },
    bookingServiceFactory: {
      async forRequest() {
        return { async cancelCalendarEvent() { cancels += 1; return { disposition: 'cancelled', state: 'cancelled' }; } };
      },
    },
    clock: () => Date.parse('2026-08-25T17:00:00.000Z'),
  });

  await service.transitionRequest({
    principal: { ...principal, roles: ['employee'], permissions: ['request:read', 'request:cancel'] },
    tenantContext,
    requestId: current.id,
    transition: 'cancel',
    correlationId: CORRELATION_ID,
  });
  await service.transitionRequest({
    principal: { ...principal, roles: ['employee'], permissions: ['request:read', 'request:cancel'] },
    tenantContext,
    requestId: current.id,
    transition: 'cancel',
    correlationId: CORRELATION_ID,
  });
  assert.equal(cancels, 2);
});
