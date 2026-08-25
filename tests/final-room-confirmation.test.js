import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinalRoomConfirmationService, FinalRoomAvailabilityError } from '../src/application/final-room-confirmation-service.js';
import { createRequestService } from '../src/application/request-service.js';
import { RequestStateConflictError } from '../src/authorization/errors.js';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import { CalendarProviderError, PROVIDER_ERROR_KIND } from '../src/integrations/calendar-contract.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = 'request-a';
const ROOM_ID = 'room-a';

function request(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    id: REQUEST_ID,
    requesterUserId: USER_ID,
    roomId: ROOM_ID,
    status: REQUEST_STATUS.IN_REVIEW,
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 4,
    externalParticipants: 1,
    statusChangedAt: '2026-08-25T16:00:00.000Z',
    createdAt: '2026-08-25T15:00:00.000Z',
    updatedAt: '2026-08-25T16:00:00.000Z',
    ...overrides,
  };
}

function dependencies({
  loadedRequest = request(),
  providerValidation = { valid: true, reason: 'available' },
  repositoryResult = { status: 'confirmed', request: request({ status: REQUEST_STATUS.CONFIRMED }) },
} = {}) {
  const calls = [];
  const repository = {
    async findByTenantIdAndId(tenantId, requestId) {
      calls.push(['find', tenantId, requestId]);
      return loadedRequest;
    },
    async confirmIfRoomAvailable(input) {
      calls.push(['commit', input]);
      return repositoryResult;
    },
  };
  const authorizationPolicy = {
    authorizeRequestRead(principal, tenantContext, loaded) {
      calls.push(['authorize-read', principal, tenantContext, loaded.id]);
      return true;
    },
    authorizeRequestTransition(principal, tenantContext, loaded, transition, reason) {
      calls.push(['authorize', principal, tenantContext, loaded.id, transition, reason]);
      return { transition: 'confirm', expectedStatus: loaded.status, nextStatus: REQUEST_STATUS.CONFIRMED, reason: null };
    },
  };
  const auditService = {
    createEvent(input) {
      return { ...input, integrityVersion: 1 };
    },
    async record(input) {
      calls.push(['audit-failure', input.metadata.reasonCode]);
    },
    async recordAuthorizationDenied(input) {
      calls.push(['audit-denied', input.metadata.operation]);
    },
  };
  const entitlementService = {
    async requireAccess(input) {
      calls.push(['entitlement', input.capabilityId, input.authorized]);
      return true;
    },
  };
  const calendarProviderFactory = {
    async forRoom(input) {
      calls.push(['provider', input]);
      return {
        async validateReservation(values) {
          calls.push(['validate', values]);
          if (providerValidation instanceof Error) throw providerValidation;
          return providerValidation;
        },
      };
    },
  };
  return { calls, repository, authorizationPolicy, auditService, entitlementService, calendarProviderFactory };
}

function service(overrides = {}) {
  const deps = dependencies(overrides);
  return {
    deps,
    service: createFinalRoomConfirmationService({
      ...deps,
      clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
    }),
  };
}

const context = {
  principal: { userId: USER_ID, tenantId: TENANT_ID, roles: ['conference_manager'], permissions: ['request:manage'] },
  tenantContext: { tenantId: TENANT_ID, status: 'active' },
  requestId: REQUEST_ID,
  correlationId: CORRELATION_ID,
};

test('final confirmation performs live final provider validation before atomic local confirmation', async () => {
  const { service: finalService, deps } = service();
  const confirmed = await finalService.confirm(context);
  assert.equal(confirmed.status, REQUEST_STATUS.CONFIRMED);
  assert.deepEqual(deps.calls.map((entry) => entry[0]), [
    'find', 'authorize', 'entitlement', 'provider', 'validate', 'commit',
  ]);
  const validation = deps.calls.find((entry) => entry[0] === 'validate')[1];
  assert.equal(validation.tenantId, TENANT_ID);
  assert.equal(validation.roomId, ROOM_ID);
  assert.equal(validation.startsAt, '2026-09-01T10:00:00.000Z');
  assert.equal(validation.endsAt, '2026-09-01T11:00:00.000Z');
  assert.equal(validation.phase, 'final');
  const commit = deps.calls.find((entry) => entry[0] === 'commit')[1];
  assert.equal(commit.tenantId, TENANT_ID);
  assert.equal(commit.requestId, REQUEST_ID);
  assert.equal(commit.expectedStatus, REQUEST_STATUS.IN_REVIEW);
  assert.equal(commit.auditEvent.newState.status, REQUEST_STATUS.CONFIRMED);
});

test('an already confirmed request is an authorized idempotent retry without provider or mutation side effects', async () => {
  const confirmedRequest = request({ status: REQUEST_STATUS.CONFIRMED });
  const { service: finalService, deps } = service({ loadedRequest: confirmedRequest });
  const repeated = await finalService.confirm(context);
  assert.equal(repeated, confirmedRequest);
  assert.deepEqual(deps.calls.map((entry) => entry[0]), ['find', 'authorize-read']);
});

test('provider conflict and provider outage fail closed before authoritative mutation', async () => {
  const conflict = service({ providerValidation: { valid: false, reason: 'conflict' } });
  await assert.rejects(conflict.service.confirm(context), RequestStateConflictError);
  assert.equal(conflict.deps.calls.some((entry) => entry[0] === 'commit'), false);
  assert.equal(conflict.deps.calls.some((entry) => entry[0] === 'audit-failure' && entry[1] === 'provider_conflict'), true);

  const outage = service({
    providerValidation: new CalendarProviderError(PROVIDER_ERROR_KIND.TIMEOUT, { operation: 'reservation_validation' }),
  });
  await assert.rejects(
    outage.service.confirm(context),
    (error) => error instanceof FinalRoomAvailabilityError && error.code === 'FINAL_ROOM_PROVIDER_UNAVAILABLE',
  );
  assert.equal(outage.deps.calls.some((entry) => entry[0] === 'commit'), false);
  assert.equal(outage.deps.calls.some((entry) => entry[0] === 'audit-failure' && entry[1] === 'provider_unavailable'), true);
});

test('room-lock conflict after live provider success still fails the final confirmation', async () => {
  const { service: finalService, deps } = service({
    repositoryResult: { status: 'room_conflict', request: request() },
  });
  await assert.rejects(finalService.confirm(context), RequestStateConflictError);
  assert.equal(deps.calls.some((entry) => entry[0] === 'validate'), true);
  assert.equal(deps.calls.some((entry) => entry[0] === 'commit'), true);
  assert.equal(
    deps.calls.some((entry) => entry[0] === 'audit-failure' && entry[1] === 'concurrent_room_conflict'),
    true,
  );
});

test('request service delegates confirm to final service while preserving other transition path', async () => {
  const calls = [];
  const finalRoomConfirmationService = {
    async confirm(input) {
      calls.push(input);
      return request({ status: REQUEST_STATUS.CONFIRMED });
    },
  };
  const requestService = createRequestService({
    repository: {
      async findByTenantIdAndId() { return request(); },
      async transitionByTenantIdAndId() { return request({ status: REQUEST_STATUS.REJECTED }); },
    },
    authorizationPolicy: {
      authorizeRequestRead() {},
      authorizeRequestTransition() {
        return { transition: 'reject', expectedStatus: REQUEST_STATUS.IN_REVIEW, nextStatus: REQUEST_STATUS.REJECTED, reason: 'reason' };
      },
    },
    auditService: {
      createEvent(input) { return input; },
      async record() {},
      async recordAuthorizationDenied() {},
    },
    finalRoomConfirmationService,
    clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
  });

  const confirmed = await requestService.transitionRequest({ ...context, transition: 'confirm' });
  assert.equal(confirmed.status, REQUEST_STATUS.CONFIRMED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requestId, REQUEST_ID);

  const rejected = await requestService.transitionRequest({ ...context, transition: 'reject', reason: 'reason' });
  assert.equal(rejected.status, REQUEST_STATUS.REJECTED);
});
