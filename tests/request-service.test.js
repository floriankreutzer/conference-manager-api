import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestService } from '../src/application/request-service.js';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
} from '../src/audit/event.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
  RequestStateConflictError,
} from '../src/authorization/errors.js';
import {
  PERMISSION,
  REQUEST_STATUS,
  REQUEST_TRANSITION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '44444444-4444-4444-8444-444444444444';
const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '77777777-7777-4777-8777-777777777777';

function principal({ userId = USER_A, roles, permissions } = {}) {
  return {
    userId,
    tenantId: TENANT_A,
    roles: roles || [TENANT_ROLE.EMPLOYEE],
    permissions: permissions || [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
  };
}

function requestRecord(overrides = {}) {
  return {
    tenantId: TENANT_A,
    id: 'REQ-1',
    requesterUserId: USER_A,
    schemaVersion: 1,
    version: 1,
    roomId: 'room-a',
    status: REQUEST_STATUS.SUBMITTED,
    statusReason: null,
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 5,
    externalParticipants: 1,
    statusChangedAt: '2026-08-24T08:00:00.000Z',
    createdAt: '2026-08-24T08:00:00.000Z',
    updatedAt: '2026-08-24T08:00:00.000Z',
    ...overrides,
  };
}

function roomContextRecord() {
  return Object.freeze({
    locationsRevision: 7,
    room: Object.freeze({
      id: 'room-a',
      siteId: 'site-a',
      name: 'Current Room A',
      capacity: 12,
      active: false,
    }),
    site: Object.freeze({
      id: 'site-a',
      name: 'Current Site A',
      active: false,
      timeZone: 'Europe/Berlin',
    }),
  });
}

function fakeRepository(initial = requestRecord(), currentRoomContext = roomContextRecord()) {
  let current = initial;
  let forceConflict = false;
  let openBookingChangeStatus = null;
  let roomContextLoads = 0;
  const committedAuditEvents = [];
  const transitionCalls = [];
  return {
    committedAuditEvents,
    transitionCalls,
    setConflict(value) {
      forceConflict = value;
    },
    setOpenBookingChangeStatus(value) {
      openBookingChangeStatus = value;
    },
    get openBookingChangeStatus() {
      return openBookingChangeStatus;
    },
    get roomContextLoads() {
      return roomContextLoads;
    },
    async findByTenantIdAndId(tenantId, requestId) {
      if (!current || current.tenantId !== tenantId || current.id !== requestId) return null;
      return current;
    },
    async findRoomContextByTenantIdAndRoomId(tenantId, roomId) {
      roomContextLoads += 1;
      if (
        !current
        || current.tenantId !== tenantId
        || current.roomId !== roomId
      ) return null;
      return currentRoomContext;
    },
    async findGuestContextByTenantIdAndRequest(tenantId, requestId, expectedVersion) {
      roomContextLoads += 1;
      if (forceConflict || !current || current.tenantId !== tenantId || current.id !== requestId
        || current.version !== expectedVersion || current.status !== REQUEST_STATUS.CONFIRMED) return null;
      return Object.freeze({ ...currentRoomContext, guestPresentation: null });
    },
    async listHistoryPageByTenantIdAndId(tenantId, requestId, { limit }) {
      if (!current || current.tenantId !== tenantId || current.id !== requestId) return [];
      return [{
        version: current.version,
        schemaVersion: current.schemaVersion,
        operation: 'migrated_legacy',
        capturedAt: current.updatedAt,
        request: { id: current.id, schemaVersion: current.schemaVersion, version: current.version },
      }].slice(0, limit);
    },
    async transitionByTenantIdAndId({
      tenantId,
      requestId,
      expectedStatus,
      expectedVersion,
      nextStatus,
      reason,
      changedAt,
      auditEvent,
      bookingChangeAuditEvent,
    }) {
      transitionCalls.push({
        tenantId,
        requestId,
        expectedStatus,
        expectedVersion,
        nextStatus,
        reason,
      });
      if (forceConflict || !current) return null;
      if (
        current.tenantId !== tenantId
        || current.id !== requestId
        || current.status !== expectedStatus
        || current.version !== expectedVersion
      ) return null;
      if (openBookingChangeStatus === 'applying') return null;
      if (openBookingChangeStatus === 'pending') {
        openBookingChangeStatus = 'superseded';
        committedAuditEvents.push(bookingChangeAuditEvent);
      }
      current = {
        ...current,
        status: nextStatus,
        statusReason: reason,
        version: current.version + 1,
        statusChangedAt: changedAt.toISOString(),
        updatedAt: changedAt.toISOString(),
      };
      committedAuditEvents.push(auditEvent);
      return current;
    },
  };
}

function service(repository, {
  bookingServiceFactory = null,
  clock = () => Date.parse('2026-08-24T09:00:00.000Z'),
} = {}) {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy, clock });
  return Object.freeze({
    audit,
    requestService: createRequestService({
      repository,
      authorizationPolicy,
      auditService: audit.service,
      finalRoomConfirmationService: {
        async confirm() {
          throw new Error('FINAL_CONFIRMATION_NOT_EXPECTED');
        },
      },
      bookingServiceFactory,
      clock,
    }),
  });
}

test('request service requires the final confirmation boundary at composition time', () => {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  assert.throws(
    () => createRequestService({
      repository: fakeRepository(),
      authorizationPolicy,
      auditService: audit.service,
    }),
    /FINAL_ROOM_CONFIRMATION_SERVICE_REQUIRED/,
  );
});

test('confirmed Request cancellation atomically supersedes a pending booking change', async () => {
  const repository = fakeRepository(requestRecord({ status: REQUEST_STATUS.CONFIRMED }));
  repository.setOpenBookingChangeStatus('pending');
  const context = service(repository);
  const updated = await context.requestService.transitionRequest({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
    expectedVersion: 1,
    correlationId: CORRELATION_ID,
  });
  assert.equal(updated.status, REQUEST_STATUS.CANCELLED);
  assert.equal(repository.openBookingChangeStatus, 'superseded');
  assert.deepEqual(repository.committedAuditEvents.map((event) => event.action), [
    AUDIT_ACTION.REQUEST_BOOKING_CHANGE,
    AUDIT_ACTION.REQUEST_TRANSITION,
  ]);
  assert.deepEqual(repository.committedAuditEvents[0].metadata, {
    operation: 'supersede',
    reasonCode: 'request_released',
    transition: REQUEST_TRANSITION.CANCEL,
  });
});

test('confirmed Request cancellation conflicts while booking-change approval is applying', async () => {
  const repository = fakeRepository(requestRecord({ status: REQUEST_STATUS.CONFIRMED }));
  repository.setOpenBookingChangeStatus('applying');
  const context = service(repository);
  await assert.rejects(context.requestService.transitionRequest({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
    expectedVersion: 1,
    correlationId: CORRELATION_ID,
  }), RequestStateConflictError);
  assert.equal(repository.openBookingChangeStatus, 'applying');
  assert.equal((await repository.findByTenantIdAndId(TENANT_A, 'REQ-1')).status, REQUEST_STATUS.CONFIRMED);
  assert.equal(repository.committedAuditEvents.length, 0);
});

test('request service returns employee-owned resources and audits concealed cross-user probes', async () => {
  const own = service(fakeRepository());
  const tenantContext = { tenantId: TENANT_A };
  assert.equal((await own.requestService.getRequest({
    principal: principal(),
    tenantContext,
    requestId: 'REQ-1',
    correlationId: CORRELATION_ID,
  })).id, 'REQ-1');
  assert.equal(own.audit.events.length, 0);

  const foreign = service(fakeRepository(requestRecord({ requesterUserId: USER_B })));
  await assert.rejects(
    foreign.requestService.getRequest({
      principal: principal(),
      tenantContext,
      requestId: 'REQ-1',
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof AuthorizationDeniedError && error.conceal === true,
  );
  assert.equal(foreign.audit.events.length, 1);
  assert.equal(foreign.audit.events[0].action, AUDIT_ACTION.AUTHORIZATION_DENIED);
  assert.equal(foreign.audit.events[0].outcome, AUDIT_OUTCOME.DENIED);
  assert.equal(foreign.audit.events[0].correlationId, CORRELATION_ID);
});

test('request room context exposes an inactive current Room only after Request object authorization', async () => {
  const repository = fakeRepository(requestRecord({ status: REQUEST_STATUS.CONFIRMED }));
  const context = service(repository);
  const result = await context.requestService.getRequestRoomContext({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    correlationId: CORRELATION_ID,
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    requestRef: {
      id: 'REQ-1',
      schemaVersion: 1,
      version: 1,
      status: REQUEST_STATUS.CONFIRMED,
    },
    currentRoomContext: roomContextRecord(),
    requestId: CORRELATION_ID,
  });
  assert.equal(repository.roomContextLoads, 1);
  assert.equal(context.audit.events.length, 0);
});

test('request room context preserves Manager scope and denies unauthorized probes before Locations lookup', async () => {
  const managerRepository = fakeRepository(requestRecord({ requesterUserId: USER_B }));
  const managerContext = service(managerRepository);
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  assert.equal((await managerContext.requestService.getRequestRoomContext({
    principal: manager,
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    correlationId: CORRELATION_ID,
  })).currentRoomContext.room.id, 'room-a');
  assert.equal(managerRepository.roomContextLoads, 1);

  for (const denied of [
    {
      caller: principal(),
      record: requestRecord({ requesterUserId: USER_B }),
    },
    {
      caller: principal({
        roles: [TENANT_ROLE.TENANT_ADMIN],
        permissions: [PERMISSION.TENANT_CONFIGURE],
      }),
      record: requestRecord({ requesterUserId: USER_B }),
    },
    {
      caller: principal(),
      record: requestRecord({ tenantId: TENANT_B }),
    },
  ]) {
    const repository = fakeRepository(denied.record);
    const context = service(repository);
    await assert.rejects(context.requestService.getRequestRoomContext({
      principal: denied.caller,
      tenantContext: { tenantId: TENANT_A },
      requestId: 'REQ-1',
      correlationId: CORRELATION_ID,
    }), AuthorizationDeniedError);
    assert.equal(repository.roomContextLoads, 0);
    assert.equal(context.audit.events.length, 1);
    assert.equal(context.audit.events[0].action, AUDIT_ACTION.AUTHORIZATION_DENIED);
    assert.deepEqual(context.audit.events[0].metadata, { operation: 'room_context' });
    assert.equal(context.audit.events[0].targetId, 'REQ-1');
  }
});

test('request room context returns null for a room-less legacy Request without consulting Locations', async () => {
  const repository = fakeRepository(requestRecord({ roomId: null }), null);
  const context = service(repository);
  const result = await context.requestService.getRequestRoomContext({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    correlationId: CORRELATION_ID,
  });

  assert.equal(result.currentRoomContext, null);
  assert.equal(repository.roomContextLoads, 0);
});

test('request service rejects malformed IDs and audits valid absent object probes', async () => {
  const context = service(fakeRepository(null));
  const tenantContext = { tenantId: TENANT_A };
  await assert.rejects(
    context.requestService.getRequest({
      principal: principal(),
      tenantContext,
      requestId: '../REQ-1',
      correlationId: CORRELATION_ID,
    }),
    AuthorizationInputError,
  );
  assert.equal(context.audit.events.length, 0);

  await assert.rejects(
    context.requestService.getRequest({
      principal: principal(),
      tenantContext,
      requestId: 'REQ-404',
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof AuthorizationDeniedError && error.conceal === true,
  );
  assert.equal(context.audit.events[0].action, AUDIT_ACTION.AUTHORIZATION_DENIED);
  assert.equal(context.audit.events[0].targetId, 'REQ-404');
});

test('request history uses the same object authorization and concealed tenant scope', async () => {
  const own = service(fakeRepository());
  const history = await own.requestService.getRequestHistory({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(history.history.map((entry) => entry.version), [1]);
  assert.deepEqual(history.page, { limit: 10, complete: true, nextCursor: null });

  const foreign = service(fakeRepository(requestRecord({ requesterUserId: USER_B })));
  await assert.rejects(foreign.requestService.getRequestHistory({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    correlationId: CORRELATION_ID,
  }), (error) => error instanceof AuthorizationDeniedError && error.conceal === true);
  assert.equal(foreign.audit.events[0].metadata.operation, 'history');
});

test('authorized transitions carry only the server policy decision into the atomic audit contract', async () => {
  const repository = fakeRepository();
  const context = service(repository);
  const updated = await context.requestService.transitionRequest({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
    expectedVersion: 1,
    correlationId: CORRELATION_ID,
  });
  assert.equal(updated.status, REQUEST_STATUS.CANCELLED);
  assert.equal(updated.statusReason, null);
  assert.equal(updated.updatedAt, '2026-08-24T09:00:00.000Z');
  assert.equal(repository.committedAuditEvents.length, 1);
  assert.deepEqual(repository.committedAuditEvents[0].previousState, { status: REQUEST_STATUS.SUBMITTED });
  assert.deepEqual(repository.committedAuditEvents[0].newState, { status: REQUEST_STATUS.CANCELLED });
  assert.equal(repository.committedAuditEvents[0].action, AUDIT_ACTION.REQUEST_TRANSITION);
  assert.equal(repository.committedAuditEvents[0].correlationId, CORRELATION_ID);
  assert.equal(repository.transitionCalls.length, 1);
  assert.equal(repository.transitionCalls[0].expectedVersion, 1);
  assert.equal(context.audit.events.length, 0);
});

test('same-status ABA rejects a stale expected version before repository or calendar side effects', async () => {
  const repository = fakeRepository(requestRecord({ version: 3, status: REQUEST_STATUS.SUBMITTED }));
  let referenceChecks = 0;
  let cancellationFactories = 0;
  const context = service(repository, {
    bookingServiceFactory: {
      async requiresCancellation() {
        referenceChecks += 1;
        return true;
      },
      async forCancellation() {
        cancellationFactories += 1;
        return {
          async cancelCalendarEvent() {
            throw new Error('CALENDAR_CANCELLATION_NOT_EXPECTED');
          },
        };
      },
    },
  });

  await assert.rejects(context.requestService.transitionRequest({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
    expectedVersion: 1,
    correlationId: CORRELATION_ID,
  }), RequestStateConflictError);

  assert.equal(repository.transitionCalls.length, 0);
  assert.equal(repository.committedAuditEvents.length, 0);
  assert.equal(referenceChecks, 0);
  assert.equal(cancellationFactories, 0);
  assert.equal(context.audit.events.length, 1);
  assert.equal(context.audit.events[0].action, AUDIT_ACTION.REQUEST_TRANSITION_FAILED);
  assert.equal(context.audit.events[0].metadata.reasonCode, 'state_conflict');
});

test('manager cancellation of another User-owned Request keeps the server actor and audit mutation atomic', async () => {
  const repository = fakeRepository(requestRecord({ requesterUserId: USER_B }));
  const context = service(repository);
  const manager = principal({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [
      PERMISSION.REQUEST_READ,
      PERMISSION.REQUEST_CANCEL,
      PERMISSION.REQUEST_MANAGE,
    ],
  });
  const updated = await context.requestService.transitionRequest({
    principal: manager,
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
    expectedVersion: 1,
    correlationId: CORRELATION_ID,
  });

  assert.equal(updated.status, REQUEST_STATUS.CANCELLED);
  assert.equal(repository.committedAuditEvents.length, 1);
  assert.equal(repository.committedAuditEvents[0].actorUserId, USER_A);
  assert.equal(repository.committedAuditEvents[0].tenantId, TENANT_A);
  assert.deepEqual(repository.committedAuditEvents[0].previousState, {
    status: REQUEST_STATUS.SUBMITTED,
  });
  assert.deepEqual(repository.committedAuditEvents[0].newState, {
    status: REQUEST_STATUS.CANCELLED,
  });
  assert.deepEqual(repository.committedAuditEvents[0].metadata, {
    reasonProvided: false,
    transition: REQUEST_TRANSITION.CANCEL,
  });
});

test('manager repeat cancellation reconciles an already-cancelled foreign Request without duplicate transition audit', async () => {
  const repository = fakeRepository(requestRecord({
    requesterUserId: USER_B,
    status: REQUEST_STATUS.CANCELLED,
  }));
  const context = service(repository);
  const manager = principal({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [
      PERMISSION.REQUEST_READ,
      PERMISSION.REQUEST_CANCEL,
      PERMISSION.REQUEST_MANAGE,
    ],
  });
  const unchanged = await context.requestService.transitionRequest({
    principal: manager,
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
    expectedVersion: 1,
    correlationId: CORRELATION_ID,
  });

  assert.equal(unchanged.status, REQUEST_STATUS.CANCELLED);
  assert.equal(repository.committedAuditEvents.length, 0);
  assert.equal(context.audit.events.length, 0);
});

test('already-target release reconciliation accepts only the exact current intent', async () => {
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  const scenarios = [
    {
      transition: REQUEST_TRANSITION.CANCEL,
      status: REQUEST_STATUS.CANCELLED,
      statusReason: null,
      caller: principal(),
      reason: undefined,
    },
    {
      transition: REQUEST_TRANSITION.REJECT,
      status: REQUEST_STATUS.REJECTED,
      statusReason: 'Insufficient detail',
      caller: manager,
      reason: '  Insufficient detail  ',
    },
    {
      transition: REQUEST_TRANSITION.REQUEST_CHANGE,
      status: REQUEST_STATUS.CHANGE_REQUESTED,
      statusReason: 'Adjust the attendee count',
      caller: manager,
      reason: '  Adjust the attendee count  ',
    },
  ];

  for (const scenario of scenarios) {
    const repository = fakeRepository(requestRecord({
      version: 5,
      status: scenario.status,
      statusReason: scenario.statusReason,
    }));
    const context = service(repository);
    const unchanged = await context.requestService.transitionRequest({
      principal: scenario.caller,
      tenantContext: { tenantId: TENANT_A },
      requestId: 'REQ-1',
      transition: scenario.transition,
      reason: scenario.reason,
      expectedVersion: 5,
      correlationId: CORRELATION_ID,
    });

    assert.equal(unchanged.version, 5);
    assert.equal(unchanged.status, scenario.status);
    assert.equal(repository.transitionCalls.length, 0);
    assert.equal(repository.committedAuditEvents.length, 0);
    assert.equal(context.audit.events.length, 0);
  }
});

test('already-target release reconciliation rejects predecessor, stale, future, and mismatched intent', async () => {
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  const attempts = [
    {
      record: requestRecord({ version: 5, status: REQUEST_STATUS.CANCELLED }),
      caller: principal(),
      transition: REQUEST_TRANSITION.CANCEL,
      expectedVersion: 4,
    },
    {
      record: requestRecord({
        version: 5,
        status: REQUEST_STATUS.REJECTED,
        statusReason: 'Insufficient detail',
      }),
      caller: manager,
      transition: REQUEST_TRANSITION.REJECT,
      reason: 'Insufficient detail',
      expectedVersion: 4,
    },
    {
      record: requestRecord({
        version: 5,
        status: REQUEST_STATUS.CHANGE_REQUESTED,
        statusReason: 'Adjust the attendee count',
      }),
      caller: manager,
      transition: REQUEST_TRANSITION.REQUEST_CHANGE,
      reason: 'Adjust the attendee count',
      expectedVersion: 4,
    },
    {
      record: requestRecord({ version: 5, status: REQUEST_STATUS.CANCELLED }),
      caller: principal(),
      transition: REQUEST_TRANSITION.CANCEL,
      expectedVersion: 3,
    },
    {
      record: requestRecord({ version: 5, status: REQUEST_STATUS.CANCELLED }),
      caller: principal(),
      transition: REQUEST_TRANSITION.CANCEL,
      expectedVersion: 6,
    },
    {
      record: requestRecord({
        version: 5,
        status: REQUEST_STATUS.REJECTED,
        statusReason: 'Insufficient detail',
      }),
      caller: manager,
      transition: REQUEST_TRANSITION.REJECT,
      reason: 'Different reason',
      expectedVersion: 4,
    },
    {
      record: requestRecord({
        version: 5,
        status: REQUEST_STATUS.CHANGE_REQUESTED,
        statusReason: 'Adjust the attendee count',
      }),
      caller: manager,
      transition: REQUEST_TRANSITION.REQUEST_CHANGE,
      reason: 'Different reason',
      expectedVersion: 5,
    },
    {
      record: requestRecord({
        version: 5,
        status: REQUEST_STATUS.REJECTED,
        statusReason: 'Insufficient detail',
      }),
      caller: manager,
      transition: REQUEST_TRANSITION.REQUEST_CHANGE,
      reason: 'Insufficient detail',
      expectedVersion: 5,
    },
  ];

  for (const attempt of attempts) {
    const repository = fakeRepository(attempt.record);
    const context = service(repository);
    await assert.rejects(context.requestService.transitionRequest({
      principal: attempt.caller,
      tenantContext: { tenantId: TENANT_A },
      requestId: 'REQ-1',
      transition: attempt.transition,
      reason: attempt.reason,
      expectedVersion: attempt.expectedVersion,
      correlationId: CORRELATION_ID,
    }), RequestStateConflictError);
    assert.equal(repository.transitionCalls.length, 0);
    assert.equal(repository.committedAuditEvents.length, 0);
    assert.equal(context.audit.events.length, 1);
    assert.equal(context.audit.events[0].action, AUDIT_ACTION.REQUEST_TRANSITION_FAILED);
    assert.equal(context.audit.events[0].metadata.reasonCode, 'state_conflict');
  }
});

test('stale authorized transition fails without overwrite and records a correlated failure', async () => {
  const repository = fakeRepository();
  repository.setConflict(true);
  const context = service(repository);
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  await assert.rejects(
    context.requestService.transitionRequest({
      principal: manager,
      tenantContext: { tenantId: TENANT_A },
      requestId: 'REQ-1',
      transition: REQUEST_TRANSITION.START_REVIEW,
      expectedVersion: 1,
      correlationId: CORRELATION_ID,
    }),
    RequestStateConflictError,
  );
  assert.equal(repository.committedAuditEvents.length, 0);
  assert.equal(repository.transitionCalls.length, 1);
  assert.equal(repository.transitionCalls[0].expectedVersion, 1);
  assert.equal(context.audit.events.length, 1);
  assert.equal(context.audit.events[0].action, AUDIT_ACTION.REQUEST_TRANSITION_FAILED);
  assert.equal(context.audit.events[0].metadata.reasonCode, 'concurrent_state_change');
  assert.equal(context.audit.events[0].correlationId, CORRELATION_ID);
});


test('guest projection preserves v1 and binds final read to the authorized confirmed Request version', async () => {
  const record = requestRecord({ status: REQUEST_STATUS.CONFIRMED, version: 4 });
  const repository = fakeRepository(record);
  const context = service(repository);
  const input = { principal: principal(), tenantContext: { tenantId: TENANT_A },
    requestId: record.id, correlationId: CORRELATION_ID };
  await assert.rejects(
    context.requestService.getRequestRoomContext({ ...input, projection: 'v2' }),
    (error) => error instanceof AuthorizationInputError
      && error.message === 'REQUEST_ROOM_CONTEXT_PROJECTION_INVALID',
  );
  assert.equal(repository.roomContextLoads, 0);
  const legacy = await context.requestService.getRequestRoomContext(input);
  assert.equal(legacy.schemaVersion, 1);
  assert.deepEqual(Object.keys(legacy).sort(), ['currentRoomContext', 'requestId', 'requestRef', 'schemaVersion']);
  assert.equal(Object.hasOwn(legacy.currentRoomContext, 'guestPresentation'), false);
  const guest = await context.requestService.getRequestRoomContext({ ...input, projection: 'guest' });
  assert.equal(guest.schemaVersion, 2);
  assert.deepEqual(Object.keys(guest).sort(), ['currentRoomContext', 'requestId', 'requestRef', 'schemaVersion']);
  assert.deepEqual(Object.keys(guest.currentRoomContext).sort(),
    ['guestPresentation', 'locationsRevision', 'room', 'site']);
  assert.equal(guest.requestRef.version, 4);
  assert.equal(guest.currentRoomContext.guestPresentation, null);
  assert.equal(guest.currentRoomContext.room.active, false);
  repository.setConflict(true);
  await assert.rejects(context.requestService.getRequestRoomContext({ ...input, projection: 'guest' }),
    RequestStateConflictError);
});

test('guest projection denies nonconfirmed and unauthorized Requests before guest configuration lookup', async () => {
  const input = { principal: principal(), tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1', correlationId: CORRELATION_ID, projection: 'guest' };
  const pending = fakeRepository();
  await assert.rejects(service(pending).requestService.getRequestRoomContext(input), RequestStateConflictError);
  assert.equal(pending.roomContextLoads, 0);
  for (const record of [requestRecord({ requesterUserId: USER_B, status: REQUEST_STATUS.CONFIRMED }),
    requestRecord({ tenantId: TENANT_B, status: REQUEST_STATUS.CONFIRMED }), null]) {
    const repository = fakeRepository(record);
    await assert.rejects(service(repository).requestService.getRequestRoomContext(input),
      (error) => error instanceof AuthorizationDeniedError && error.conceal === true);
    assert.equal(repository.roomContextLoads, 0);
  }
  const foreign = requestRecord({ requesterUserId: USER_B, status: REQUEST_STATUS.CONFIRMED });
  const adminRepository = fakeRepository(foreign);
  await assert.rejects(service(adminRepository).requestService.getRequestRoomContext({ ...input,
    principal: principal({ roles: [TENANT_ROLE.TENANT_ADMIN], permissions: [PERMISSION.TENANT_CONFIGURE] }),
  }), AuthorizationDeniedError);
  assert.equal(adminRepository.roomContextLoads, 0);
  const manager = service(fakeRepository(foreign));
  const result = await manager.requestService.getRequestRoomContext({ ...input,
    principal: principal({ roles: [TENANT_ROLE.CONFERENCE_MANAGER],
      permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE] }),
  });
  assert.equal(result.schemaVersion, 2);
});
