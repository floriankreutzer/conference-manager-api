import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookingChangeService } from '../src/application/booking-change-service.js';
import { BookingChangeConflictError, BookingChangeDependencyError } from '../src/application/booking-change-errors.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { normalizeBookingChange } from '../src/domain/booking-change.js';
import { normalizeRequest } from '../src/domain/request.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const MANAGER_ID = '33333333-3333-4333-8333-333333333333';
const CHANGE_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';

function request(overrides = {}) {
  return normalizeRequest({
    tenantId: TENANT_ID,
    id: 'CR-68',
    requesterUserId: REQUESTER_ID,
    roomId: 'room-1',
    status: 'Confirmed',
    statusReason: null,
    startsAt: '2026-09-01T08:00:00.000Z',
    endsAt: '2026-09-01T09:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 0,
    statusChangedAt: '2026-08-20T10:00:00.000Z',
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  });
}

function change(overrides = {}) {
  return normalizeBookingChange({
    tenantId: TENANT_ID,
    id: CHANGE_ID,
    requestId: 'CR-68',
    initiatorUserId: REQUESTER_ID,
    status: 'pending',
    roomId: 'room-1',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 3,
    externalParticipants: 0,
    baseRequestUpdatedAt: '2026-08-20T10:00:00.000Z',
    decidedByUserId: null,
    rejectionReason: null,
    createdAt: '2026-08-26T10:00:00.000Z',
    updatedAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  });
}

function principal(userId, roles) {
  const authorization = tenantAuthorizationSnapshot(roles);
  return Object.freeze({ tenantId: TENANT_ID, userId, ...authorization });
}

function service({ repository = {}, booking = {} } = {}) {
  const current = request();
  const calls = [];
  const changeRepository = {
    async listAlternatives() { return Object.freeze(['room-2']); },
    async findOpen() { return null; },
    async propose(values) {
      calls.push(['propose', values]);
      return { status: 'pending', change: change(), request: current };
    },
    async beginApproval(values) {
      calls.push(['begin', values]);
      return { status: 'applying', change: change({ status: 'applying', decidedByUserId: MANAGER_ID }), request: current };
    },
    async finishApproval(values) {
      calls.push(['finish', values]);
      return { status: 'applied', request: request({
        startsAt: '2026-09-01T10:00:00.000Z',
        endsAt: '2026-09-01T11:00:00.000Z',
        internalParticipants: 3,
        updatedAt: '2026-08-26T10:00:02.000Z',
      }) };
    },
    async returnToPending(values) { calls.push(['pending', values]); return change(); },
    async reject(values) { calls.push(['reject', values]); return change({
      status: 'rejected', decidedByUserId: MANAGER_ID, rejectionReason: values.reason,
    }); },
    ...repository,
  };
  const bookingService = {
    async validateReservation() { return { valid: true, reason: 'available' }; },
    async updateCalendarEvent() { calls.push(['calendar-update']); return { state: 'active' }; },
    ...booking,
  };
  return {
    calls,
    instance: createBookingChangeService({
      repository: changeRepository,
      requestRepository: { async findByTenantIdAndId() { return current; } },
      authorizationPolicy: createAuthorizationPolicy(),
      auditService: {
        createEvent: (event) => Object.freeze(event),
        async record(event) { calls.push(['audit', event]); },
      },
      bookingServiceFactory: {
        async forRequest() { return bookingService; },
        async moveCalendarEvent() { throw new Error('UNEXPECTED_MOVE'); },
        async rollbackCalendarMove() { throw new Error('UNEXPECTED_ROLLBACK'); },
      },
      clock: (() => { let value = Date.parse('2026-08-26T10:00:00.000Z'); return () => value += 1_000; })(),
      idFactory: () => CHANGE_ID,
    }),
  };
}

test('requester and Conference Manager may propose, while participant-only changes apply directly', async () => {
  const { instance, calls } = service({
    repository: {
      async propose(values) {
        calls.push(['propose', values]);
        return { status: 'applied', change: change({
          status: 'applied', startsAt: request().startsAt, endsAt: request().endsAt,
        }), request: request({ internalParticipants: 3 }) };
      },
    },
  });
  const result = await instance.propose({
    principal: principal(REQUESTER_ID, ['employee']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    proposed: {
      roomId: 'room-1',
      startsAt: request().startsAt,
      endsAt: request().endsAt,
      internalParticipants: 3,
      externalParticipants: 0,
    },
  });
  assert.equal(result.change.status, 'applied');
  assert.equal(calls[0][1].initiatorUserId, REQUESTER_ID);
});

test('exactly one open booking change is enforced as a stable conflict', async () => {
  const { instance } = service({ repository: { async propose() { return { status: 'open_exists' }; } } });
  await assert.rejects(instance.propose({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    proposed: {
      roomId: 'room-1', startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-09-01T11:00:00.000Z', internalParticipants: 3, externalParticipants: 0,
    },
  }), (error) => error instanceof BookingChangeConflictError
    && error.code === 'BOOKING_CHANGE_OPEN_EXISTS');
});

test('Conference Manager approval validates, updates the mapped event and commits before notification', async () => {
  const { instance, calls } = service();
  const result = await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'calendar-update', 'finish']);
});

test('provider failure restores the original event and returns the proposal to pending for retry', async () => {
  let attempt = 0;
  const { instance, calls } = service({ booking: {
    async updateCalendarEvent() {
      attempt += 1;
      calls.push([attempt === 1 ? 'calendar-failure' : 'calendar-restore']);
      if (attempt === 1) throw new Error('PROVIDER_UNAVAILABLE');
      return { state: 'active' };
    },
  } });
  await assert.rejects(instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  }), BookingChangeDependencyError);
  assert.deepEqual(calls.map(([name]) => name), [
    'begin', 'calendar-failure', 'calendar-restore', 'pending',
  ]);
});

test('provider validation failure leaves the original event untouched and returns the proposal to pending', async () => {
  const { instance, calls } = service({ booking: {
    async validateReservation() {
      calls.push(['calendar-validation-failure']);
      throw new Error('PROVIDER_UNAVAILABLE');
    },
  } });
  await assert.rejects(instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  }), BookingChangeDependencyError);
  assert.deepEqual(calls.map(([name]) => name), [
    'begin', 'calendar-validation-failure', 'pending',
  ]);
});

test('approval conflict remains pending and returns bounded alternatives without Graph mutation', async () => {
  const { instance, calls } = service({ repository: {
    async beginApproval(values) {
      calls.push(['begin', values]);
      return { status: 'blocked', alternatives: ['room-2', 'room-3'] };
    },
  } });
  assert.deepEqual(await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  }), { status: 'blocked', alternatives: ['room-2', 'room-3'] });
  assert.deepEqual(calls.map(([name]) => name), ['begin']);
});
