import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinalRoomConfirmationService, FinalRoomAvailabilityError } from '../src/application/final-room-confirmation-service.js';
import { createRequestService } from '../src/application/request-service.js';
import { asApiError } from '../src/api-error.js';
import { RequestStateConflictError } from '../src/authorization/errors.js';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import { EntitlementDeniedError } from '../src/entitlements/errors.js';
import { CalendarProviderError, PROVIDER_ERROR_KIND } from '../src/integrations/calendar-contract.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = 'request-a';
const ROOM_ID = 'room-a';
const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444';
const PROVIDER_TENANT = '55555555-5555-4555-8555-555555555555';
const PROVIDER_RESOURCE = 'room-a@example.invalid';

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
  providerFactoryError = null,
  repositoryResult = { status: 'confirmed', request: request({ status: REQUEST_STATUS.CONFIRMED }) },
} = {}) {
  const calls = [];
  const repository = {
    async withFinalConfirmationLock(_input, work) { return work(); },
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
    async evaluateAccess(input) {
      calls.push(['entitlement-evaluate', input.capabilityId, input.authorized]);
      return false;
    },
  };
  const calendarProviderFactory = {
    async forRoom(input) {
      calls.push(['provider', input]);
      if (providerFactoryError) throw providerFactoryError;
      return {
        integrationId: INTEGRATION_ID,
        integrationProvider: 'microsoft365',
        identityProvider: 'microsoft_entra',
        providerConnectionReference: PROVIDER_TENANT,
        providerResourceReference: PROVIDER_RESOURCE,
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
  assert.deepEqual(commit.calendarAuthority, {
    integrationId: INTEGRATION_ID,
    integrationProvider: 'microsoft365',
    identityProvider: 'microsoft_entra',
    providerConnectionReference: PROVIDER_TENANT,
    roomId: ROOM_ID,
    providerResourceReference: PROVIDER_RESOURCE,
    calendarWriteEnabled: false,
  });
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
  let dependencyError;
  try {
    await outage.service.confirm(context);
  } catch (error) {
    dependencyError = error;
  }
  assert.equal(dependencyError instanceof FinalRoomAvailabilityError, true);
  assert.equal(dependencyError.code, 'FINAL_ROOM_PROVIDER_UNAVAILABLE');
  assert.equal(asApiError(dependencyError).statusCode, 503);
  assert.equal(asApiError(dependencyError).code, 'CALENDAR_DEPENDENCY_UNAVAILABLE');
  assert.equal(outage.deps.calls.some((entry) => entry[0] === 'commit'), false);
  assert.equal(outage.deps.calls.some((entry) => entry[0] === 'audit-failure' && entry[1] === 'provider_unavailable'), true);
});

test('unexpected availability and calendar-write factory failures map to dependency errors', async () => {
  const availability = service({ providerFactoryError: new Error('unexpected provider factory failure') });
  await assert.rejects(
    availability.service.confirm(context),
    (error) => error instanceof FinalRoomAvailabilityError
      && error.code === 'FINAL_ROOM_PROVIDER_UNAVAILABLE'
      && asApiError(error).statusCode === 503,
  );
  assert.equal(
    availability.deps.calls.some(
      (entry) => entry[0] === 'audit-failure' && entry[1] === 'provider_unavailable',
    ),
    true,
  );

  const deps = dependencies();
  deps.entitlementService.evaluateAccess = async () => true;
  const finalService = createFinalRoomConfirmationService({
    ...deps,
    bookingServiceFactory: {
      async forProvider() {
        throw new Error('unexpected booking factory failure');
      },
    },
    clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
  });
  await assert.rejects(
    finalService.confirm(context),
    (error) => error instanceof FinalRoomAvailabilityError
      && error.code === 'FINAL_ROOM_CALENDAR_WRITE_UNAVAILABLE'
      && asApiError(error).statusCode === 503,
  );
  assert.equal(
    deps.calls.some(
      (entry) => entry[0] === 'audit-failure' && entry[1] === 'calendar_write_unavailable',
    ),
    true,
  );
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

test('commit-time provider authority loss compensates an enabled write and fails as a stable dependency error', async () => {
  const deps = dependencies({
    repositoryResult: { status: 'provider_authority_conflict', request: request() },
  });
  deps.entitlementService.evaluateAccess = async () => true;
  let creates = 0;
  let compensations = 0;
  const finalService = createFinalRoomConfirmationService({
    ...deps,
    bookingServiceFactory: {
      async forProvider(target, provider) {
        assert.equal(target.id, REQUEST_ID);
        assert.equal(provider.providerResourceReference, PROVIDER_RESOURCE);
        return {
          async createCalendarEvent() { creates += 1; },
          async compensateCalendarEvent() { compensations += 1; },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
  });

  await assert.rejects(
    finalService.confirm(context),
    (error) => error instanceof FinalRoomAvailabilityError
      && error.code === 'FINAL_ROOM_PROVIDER_AUTHORITY_LOST'
      && asApiError(error).statusCode === 503
      && asApiError(error).code === 'CALENDAR_DEPENDENCY_UNAVAILABLE',
  );
  assert.equal(creates, 1);
  assert.equal(compensations, 1);
  assert.equal(
    deps.calls.some(
      (entry) => entry[0] === 'audit-failure' && entry[1] === 'provider_authority_lost',
    ),
    true,
  );
});

test('write-disabled confirmation reconciles a pre-existing calendar reference before commit', async () => {
  const deps = dependencies();
  deps.entitlementService.evaluateAccess = async () => false;
  const order = [];
  const finalService = createFinalRoomConfirmationService({
    ...deps,
    bookingServiceFactory: {
      async requiresCancellation(target) {
        order.push('reference-check');
        assert.equal(target.id, REQUEST_ID);
        return true;
      },
      async forCancellation(target) {
        order.push('cleanup-factory');
        assert.equal(target.id, REQUEST_ID);
        return {
          async cancelCalendarEvent() { order.push('cleanup'); },
        };
      },
      async forProvider() { throw new Error('WRITE_FACTORY_MUST_NOT_RUN'); },
    },
    clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
  });
  deps.repository.confirmIfRoomAvailable = async (input) => {
    order.push('commit');
    assert.equal(input.calendarAuthority.calendarWriteEnabled, false);
    return { status: 'confirmed', request: request({ status: REQUEST_STATUS.CONFIRMED }) };
  };

  assert.equal((await finalService.confirm(context)).status, REQUEST_STATUS.CONFIRMED);
  assert.deepEqual(order, ['reference-check', 'cleanup-factory', 'cleanup', 'commit']);
});

test('commit-time provider authority loss with write disabled never invokes write or compensation', async () => {
  const deps = dependencies({
    repositoryResult: { status: 'provider_authority_conflict', request: request() },
  });
  deps.entitlementService.evaluateAccess = async () => false;
  let factoryCalls = 0;
  let compensations = 0;
  const finalService = createFinalRoomConfirmationService({
    ...deps,
    bookingServiceFactory: {
      async requiresCancellation() { return false; },
      async forCancellation() { throw new Error('UNREACHABLE'); },
      async forProvider() {
        factoryCalls += 1;
        return {
          async createCalendarEvent() {},
          async compensateCalendarEvent() { compensations += 1; },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
  });

  await assert.rejects(
    finalService.confirm(context),
    (error) => error instanceof FinalRoomAvailabilityError
      && error.code === 'FINAL_ROOM_PROVIDER_AUTHORITY_LOST'
      && asApiError(error).statusCode === 503,
  );
  assert.equal(factoryCalls, 0);
  assert.equal(compensations, 0);
  assert.equal(
    deps.calls.filter((entry) => entry[0] === 'commit').length,
    1,
  );
  assert.equal(
    deps.calls.some(
      (entry) => entry[0] === 'audit-failure' && entry[1] === 'provider_authority_lost',
    ),
    true,
  );
});

test('parallel confirms reconcile the authoritative winner without loser compensation or cross-request locking', async () => {
  let current = request();
  let releaseCreate;
  let createStartedResolve;
  const createStarted = new Promise((resolve) => { createStartedResolve = resolve; });
  const createBarrier = new Promise((resolve) => { releaseCreate = resolve; });
  let creates = 0;
  let compensations = 0;
  let commits = 0;
  const deps = dependencies();
  deps.repository.findByTenantIdAndId = async () => current;
  deps.repository.confirmIfRoomAvailable = async () => {
    commits += 1;
    if (current.status === REQUEST_STATUS.CONFIRMED) {
      return { status: 'state_conflict', request: current };
    }
    current = request({ status: REQUEST_STATUS.CONFIRMED });
    return { status: 'confirmed', request: current };
  };
  deps.entitlementService.evaluateAccess = async () => true;
  const finalService = createFinalRoomConfirmationService({
    ...deps,
    bookingServiceFactory: {
      async forProvider() {
        return {
          async createCalendarEvent() {
            creates += 1;
            createStartedResolve();
            await createBarrier;
          },
          async compensateCalendarEvent() { compensations += 1; },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
  });

  const first = finalService.confirm(context);
  await createStarted;
  const second = finalService.confirm({
    ...context,
    correlationId: '44444444-4444-4444-8444-444444444444',
  });
  releaseCreate();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((entry) => entry.status), [REQUEST_STATUS.CONFIRMED, REQUEST_STATUS.CONFIRMED]);
  assert.equal(creates, 2);
  assert.equal(commits, 2);
  assert.equal(compensations, 0);
});

test('unknown local commit response reconciles an authoritative confirmation without deleting its event', async () => {
  let current = request();
  let compensations = 0;
  const deps = dependencies();
  deps.repository.findByTenantIdAndId = async () => current;
  deps.repository.confirmIfRoomAvailable = async () => {
    current = request({ status: REQUEST_STATUS.CONFIRMED });
    throw new Error('COMMIT_RESPONSE_LOST');
  };
  deps.entitlementService.evaluateAccess = async () => true;
  const finalService = createFinalRoomConfirmationService({
    ...deps,
    bookingServiceFactory: {
      async forProvider() {
        return {
          async createCalendarEvent() {},
          async compensateCalendarEvent() { compensations += 1; },
        };
      },
    },
    clock: () => Date.parse('2026-08-25T16:30:00.000Z'),
  });

  assert.equal((await finalService.confirm(context)).status, REQUEST_STATUS.CONFIRMED);
  assert.equal(compensations, 0);
});

test('unknown unconfirmed commit outcome retains the event for reconciliation instead of racing another commit', async () => {
  let compensations = 0;
  const deps = dependencies();
  deps.repository.confirmIfRoomAvailable = async () => {
    throw new Error('COMMIT_OUTCOME_UNKNOWN');
  };
  deps.entitlementService.evaluateAccess = async () => true;
  const finalService = createFinalRoomConfirmationService({
    ...deps,
    bookingServiceFactory: {
      async forProvider() {
        return {
          async createCalendarEvent() {},
          async compensateCalendarEvent() { compensations += 1; },
        };
      },
    },
  });

  await assert.rejects(
    finalService.confirm(context),
    (error) => error instanceof FinalRoomAvailabilityError
      && error.code === 'FINAL_ROOM_CONFIRMATION_RECONCILIATION_REQUIRED'
      && asApiError(error).statusCode === 503,
  );
  assert.equal(compensations, 0);
  assert.equal(
    deps.calls.some(
      (entry) => entry[0] === 'audit-failure' && entry[1] === 'confirmation_outcome_unknown',
    ),
    true,
  );
});

test('calendar entitlement denial is a stable 403 while evaluation dependency failure is audited as 503', async () => {
  const denied = service();
  denied.deps.entitlementService.requireAccess = async () => {
    throw new EntitlementDeniedError();
  };
  await assert.rejects(
    denied.service.confirm(context),
    (error) => asApiError(error).statusCode === 403
      && asApiError(error).code === 'ENTITLEMENT_ACCESS_DENIED',
  );
  assert.equal(
    denied.deps.calls.some(
      (entry) => entry[0] === 'audit-failure' && entry[1] === 'calendar_entitlement_denied',
    ),
    true,
  );

  const unavailableDeps = dependencies();
  unavailableDeps.entitlementService.evaluateAccess = async () => {
    throw new Error('ENTITLEMENT_REPOSITORY_UNAVAILABLE');
  };
  const unavailable = createFinalRoomConfirmationService({
    ...unavailableDeps,
    bookingServiceFactory: { async forProvider() { throw new Error('UNREACHABLE'); } },
  });
  await assert.rejects(
    unavailable.confirm(context),
    (error) => error instanceof FinalRoomAvailabilityError
      && error.code === 'FINAL_ROOM_ENTITLEMENT_UNAVAILABLE'
      && asApiError(error).statusCode === 503,
  );
  assert.equal(
    unavailableDeps.calls.some(
      (entry) => entry[0] === 'audit-failure' && entry[1] === 'calendar_entitlement_unavailable',
    ),
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
      authorizeRequestReconciliation() {},
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
