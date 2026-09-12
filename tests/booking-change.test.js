import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookingChangeService } from '../src/application/booking-change-service.js';
import {
  BOOKING_CHANGE_MOVE_RECOVERY,
  BookingChangeCalendarMoveError,
  BookingChangeConflictError,
  BookingChangeDependencyError,
} from '../src/application/booking-change-errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { normalizeBookingChange } from '../src/domain/booking-change.js';
import {
  createRequestCompositionSnapshot,
  priceRequestCompositionForSchemaVersion,
} from '../src/domain/request-composition.js';
import { normalizeRequest, toPublicRequest } from '../src/domain/request.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const MANAGER_ID = '33333333-3333-4333-8333-333333333333';
const CHANGE_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';

function proposed(overrides = {}) {
  return {
    title: 'Confirmed event',
    roomId: 'room-1',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 3,
    externalParticipants: 0,
    serviceIds: [],
    catering: {
      participantCount: 0,
      packageSelection: null,
      itemQuantities: [],
    },
    dietaryRequirements: null,
    specialRequirements: null,
    allocations: [],
    configurationRevisions: {
      organization: 1,
      locations: 1,
      catalogue: 1,
      bookingPolicies: 1,
      costAllocation: 1,
    },
    ...overrides,
  };
}

function v2Snapshot(input, requestVersion, schemaVersion = 2) {
  const capturedAt = '2026-08-26T10:00:00.000Z';
  const room = {
    id: input.roomId,
    siteId: 'site-1',
    name: 'Room 1',
    price: { amountMinor: 0, currency: 'EUR' },
  };
  const catalogueSnapshot = {
    schemaVersion: 1,
    catalogRevision: 1,
    capturedAt,
    siteId: 'site-1',
    roomId: input.roomId,
    services: [],
    equipment: (input.equipmentIds ?? []).map((id) => ({
      id, name: `Equipment ${id}`, description: null, price: { amountMinor: 2500, currency: 'EUR' },
    })),
    cateringItems: [],
    catering: [],
  };
  const pricing = priceRequestCompositionForSchemaVersion({
    schemaVersion,
    draft: input, room, catalogueSnapshot, defaultCurrency: 'EUR',
  });
  return createRequestCompositionSnapshot({
    schemaVersion,
    draft: input,
    requestVersion,
    capturedAt,
    room,
    catalogueSnapshot,
    bookingPolicySnapshot: {
      policyVersionId: 'policy-v1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      evaluatedAt: capturedAt,
      rules: {
        minimumLeadTimeMinutes: 0,
        maximumAdvanceMinutes: 527_040,
        cancellationWindowMinutes: 0,
        changeWindowMinutes: 0,
        maximumParticipants: 500,
        allowedSiteIds: [],
        allowedRoomIds: [],
        allowedServiceIds: [],
      },
    },
    allocationSnapshot: {
      schemaVersion: 1,
      configurationRevision: 1,
      snapshottedAt: capturedAt,
      model: 'percentage_basis_points',
      totalBasisPoints: 0,
      totalMinor: pricing.totalMinor,
      allocatedMinor: 0,
      unallocatedMinor: pricing.totalMinor,
      currency: pricing.currency,
      entries: [],
    },
    revisions: input.configurationRevisions,
    defaultCurrency: 'EUR',
  });
}

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

function service({
  repository = {},
  booking = {},
  bookingFactory = {},
  audit = {},
  current = request(),
} = {}) {
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
    async findApprovalState() {
      return {
        status: 'applying',
        change: change({ status: 'applying', decidedByUserId: MANAGER_ID }),
        request: current,
      };
    },
    async finishApproval(values) {
      calls.push(['finish', values]);
      return {
        status: 'applied',
        change: change({
          status: 'applied',
          updatedAt: '2026-08-26T10:00:02.000Z',
        }),
        request: request({
          version: 2,
          startsAt: '2026-09-01T10:00:00.000Z',
          endsAt: '2026-09-01T11:00:00.000Z',
          internalParticipants: 3,
          updatedAt: '2026-08-26T10:00:02.000Z',
        }),
      };
    },
    async recordCalendarMoveTarget(values) {
      calls.push(['record-target', values]);
      return change({
        status: 'applying',
        decidedByUserId: MANAGER_ID,
        moveAttemptNumber: values.moveAttemptNumber,
        recoveryPhase: 'target_active',
        calendarReplacement: values.calendarReplacement,
      });
    },
    async beginCalendarMoveRollback(values) {
      calls.push(['begin-rollback', values]);
      return change({
        status: 'applying',
        decidedByUserId: MANAGER_ID,
        moveAttemptNumber: values.moveAttemptNumber,
        recoveryPhase: 'restore_pending',
        calendarReplacement: values.calendarReplacement ?? movedCalendarResult().replacement,
      });
    },
    async completeCalendarMoveRollback(values) {
      calls.push(['complete-rollback', values]);
      return change();
    },
    async markCalendarMoveReconciliationRequired(values) {
      calls.push(['reconciliation-required', values]);
      return change({
        status: 'applying',
        decidedByUserId: MANAGER_ID,
        moveAttemptNumber: values.moveAttemptNumber,
        recoveryPhase: 'reconciliation_required',
        calendarReplacement: values.calendarReplacement,
      });
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
        createEvent({ principal: actor, tenantContext, ...event }) {
          return Object.freeze({
            tenantId: tenantContext.tenantId,
            actorUserId: actor.userId,
            ...event,
          });
        },
        async record(event) { calls.push(['audit', event]); },
        async recordAuthorizationDenied(event) { calls.push(['denied', event]); },
        ...audit,
      },
      bookingServiceFactory: {
        async forRequest() { return bookingService; },
        async moveCalendarEvent() { throw new Error('UNEXPECTED_MOVE'); },
        async rollbackCalendarMove() { throw new Error('UNEXPECTED_ROLLBACK'); },
        ...bookingFactory,
      },
      clock: (() => { let value = Date.parse('2026-08-26T10:00:00.000Z'); return () => value += 1_000; })(),
      idFactory: () => CHANGE_ID,
    }),
  };
}

function movedCalendarResult() {
  return Object.freeze({
    status: 'moved',
    disposition: 'created',
    replacement: Object.freeze({
      integrationId: '66666666-6666-4666-8666-666666666666',
      previousProviderReference: 'old-event',
      previousProviderResourceReference: 'old-room@example.com',
      providerReference: 'new-event',
      providerResourceReference: 'new-room@example.com',
      idempotencyKey: 'a'.repeat(64),
    }),
  });
}

function v2PendingChange(nextDraftOverrides = {}) {
  const baseDraft = proposed({
    startsAt: '2026-09-01T08:00:00.000Z',
    endsAt: '2026-09-01T09:00:00.000Z',
    internalParticipants: 2,
  });
  const current = request({
    schemaVersion: 2,
    version: 1,
    snapshot: v2Snapshot(baseDraft, 1),
  });
  const nextDraft = proposed({
    ...baseDraft,
    ...nextDraftOverrides,
  });
  const pending = change({
    requestSchemaVersion: 2,
    baseRequestVersion: 1,
    requestDraft: nextDraft,
    proposedRequestSnapshot: v2Snapshot(nextDraft, 2),
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
  });
  return { current, nextDraft, pending };
}

test('v2 booking-change responses expose the authoritative next-version Request projection', async () => {
  const { current, nextDraft, pending } = v2PendingChange({
    specialRequirements: 'Updated room layout',
  });
  const rejected = normalizeBookingChange({
    ...pending,
    status: 'rejected',
    decidedByUserId: MANAGER_ID,
    rejectionReason: 'Room layout cannot be supported.',
  });
  const { instance } = service({
    current,
    repository: {
      async findOpen() { return pending; },
      async propose() { return { status: 'pending', change: pending, request: current }; },
      async reject() { return rejected; },
    },
  });
  const expected = toPublicRequest({
    ...current,
    schemaVersion: 2,
    version: 2,
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
    snapshot: pending.proposedRequestSnapshot,
  });
  const found = await instance.findOpen({
    principal: principal(REQUESTER_ID, ['employee']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
  });
  assert.deepEqual(found.change.request, nextDraft);
  assert.deepEqual(found.change.proposedRequest, expected);
  assert.equal('tenantId' in found.change.proposedRequest, false);
  assert.equal('requesterUserId' in found.change.proposedRequest, false);
  assert.deepEqual(found.requestRef, {
    id: current.id,
    schemaVersion: current.schemaVersion,
    version: current.version,
    status: current.status,
  });

  const proposedResult = await instance.propose({
    principal: principal(REQUESTER_ID, ['employee']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    schemaVersion: 2,
    expectedVersion: 1,
    proposed: nextDraft,
  });
  assert.deepEqual(proposedResult.change.proposedRequest, expected);

  const rejectedResult = await instance.reject({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
    rejectionReason: 'Room layout cannot be supported.',
  });
  assert.deepEqual(rejectedResult.change.proposedRequest, expected);
});

test('legacy booking-change responses expose no fabricated proposed Request', async () => {
  const current = request();
  const { instance } = service({
    current,
    repository: { async findOpen() { return change(); } },
  });
  const found = await instance.findOpen({
    principal: principal(REQUESTER_ID, ['employee']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
  });
  assert.equal(found.change.request, null);
  assert.equal(found.change.proposedRequest, null);
});

test('booking-change projection fails closed for corrupt or cross-object persisted proposals', async () => {
  const { current, nextDraft, pending } = v2PendingChange({
    specialRequirements: 'Updated room layout',
  });
  const corrupt = structuredClone(pending);
  corrupt.proposedRequestSnapshot.details.title = 'Different persisted proposal';
  const crossObject = { ...pending, requestId: 'CR-OTHER' };
  const nonBaseRequest = normalizeRequest({
    ...current,
    version: 2,
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
    snapshot: pending.proposedRequestSnapshot,
  });
  const changedWithoutVersion = normalizeRequest({
    ...current,
    updatedAt: '2026-08-20T10:00:01.000Z',
  });
  for (const [stored, authorizedRequest] of [
    [corrupt, current],
    [crossObject, current],
    [pending, nonBaseRequest],
    [pending, changedWithoutVersion],
  ]) {
    const { instance } = service({
      current: authorizedRequest,
      repository: { async findOpen() { return stored; } },
    });
    await assert.rejects(instance.findOpen({
      principal: principal(REQUESTER_ID, ['employee']),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
      requestId: 'CR-68',
    }), /BOOKING_CHANGE_PROJECTION_INVALID/);
  }
});

test('booking-change authorization denials are concealed, minimized and auditable', async () => {
  const tenantContext = { tenantId: TENANT_ID, status: 'active' };
  const employee = principal(MANAGER_ID, ['employee']);
  const tenantAdmin = principal(MANAGER_ID, ['employee', 'tenant_admin']);
  const manager = principal(MANAGER_ID, ['conference_manager']);

  for (const deniedPrincipal of [employee, tenantAdmin]) {
    const denied = service();
    await assert.rejects(denied.instance.propose({
      principal: deniedPrincipal,
      tenantContext,
      correlationId: CORRELATION_ID,
      requestId: 'CR-68',
      schemaVersion: 2,
      expectedVersion: 1,
      proposed: proposed(),
    }), (error) => error instanceof AuthorizationDeniedError && error.conceal === true);
    assert.deepEqual(denied.calls, [[
      'denied',
      {
        principal: deniedPrincipal,
        tenantContext,
        correlationId: CORRELATION_ID,
        targetType: 'request',
        targetId: 'CR-68',
        metadata: { operation: 'booking_change_propose' },
      },
    ]]);
  }

  for (const operation of ['propose', 'approve']) {
    const crossTenant = service({
      current: request({ tenantId: '66666666-6666-4666-8666-666666666666' }),
    });
    const input = {
      principal: manager,
      tenantContext,
      correlationId: CORRELATION_ID,
      requestId: 'CR-68',
      ...(operation === 'propose'
        ? { schemaVersion: 2, expectedVersion: 1, proposed: proposed() }
        : { changeId: CHANGE_ID }),
    };
    await assert.rejects(
      crossTenant.instance[operation](input),
      (error) => error instanceof AuthorizationDeniedError && error.conceal === true,
    );
    assert.equal(crossTenant.calls.length, 1);
    assert.equal(crossTenant.calls[0][0], 'denied');
    assert.equal(
      crossTenant.calls[0][1].metadata.operation,
      operation === 'propose' ? 'booking_change_propose' : 'booking_change_decision',
    );
    assert.equal('changeId' in crossTenant.calls[0][1].metadata, false);
  }

  const crossTenantChangeId = service({
    repository: {
      async beginApproval(values) {
        return { status: 'conflict', values };
      },
    },
  });
  await assert.rejects(
    crossTenantChangeId.instance.approve({
      principal: manager,
      tenantContext,
      correlationId: CORRELATION_ID,
      requestId: 'CR-68',
      changeId: '77777777-7777-4777-8777-777777777777',
    }),
    BookingChangeConflictError,
  );
  assert.equal(crossTenantChangeId.calls.length, 1);
  assert.deepEqual(crossTenantChangeId.calls[0], [
    'denied',
    {
      principal: manager,
      tenantContext,
      correlationId: CORRELATION_ID,
      targetType: 'request',
      targetId: 'CR-68',
      metadata: { operation: 'booking_change_decision' },
    },
  ]);
});

test('same Conference Manager may propose and approve with attributed audit evidence', async () => {
  const manager = principal(MANAGER_ID, ['conference_manager']);
  const tenantContext = { tenantId: TENANT_ID, status: 'active' };
  const { instance, calls } = service();

  const pending = await instance.propose({
    principal: manager,
    tenantContext,
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    schemaVersion: 2,
    expectedVersion: 1,
    proposed: proposed(),
  });
  assert.equal(pending.change.status, 'pending');

  const applied = await instance.approve({
    principal: manager,
    tenantContext,
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(applied.change.status, 'applied');

  const proposal = calls.find(([operation]) => operation === 'propose')[1];
  const approval = calls.find(([operation]) => operation === 'begin')[1];
  assert.equal(proposal.initiatorUserId, MANAGER_ID);
  assert.equal(approval.deciderUserId, MANAGER_ID);
  assert.equal(proposal.initiatorUserId, approval.deciderUserId);

  const evidence = [
    proposal.auditEvent,
    approval.auditEvent,
    calls.find(([operation]) => operation === 'finish')[1].auditEvent,
  ];
  assert.deepEqual(
    evidence.map((event) => ({
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      correlationId: event.correlationId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      outcome: event.outcome,
      retentionClass: event.retentionClass,
      operation: event.metadata.operation,
    })),
    ['propose', 'approve_begin', 'approve_applied'].map((operation) => ({
      tenantId: TENANT_ID,
      actorUserId: MANAGER_ID,
      correlationId: CORRELATION_ID,
      action: 'request.booking_change',
      targetType: 'request',
      targetId: 'CR-68',
      outcome: 'success',
      retentionClass: 'business',
      operation,
    })),
  );
});

test('direct-applied v2 proposal returns one exact authoritative projection and a bounded Request ref', async () => {
  const { current, nextDraft, pending } = v2PendingChange({ internalParticipants: 3 });
  const appliedChange = normalizeBookingChange({ ...pending, status: 'applied' });
  const appliedRequest = normalizeRequest({
    ...current,
    version: 2,
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
    snapshot: pending.proposedRequestSnapshot,
  });
  const { instance } = service({
    current,
    repository: {
      async propose() {
        return { status: 'applied', change: appliedChange, request: appliedRequest };
      },
    },
  });
  const result = await instance.propose({
    principal: principal(REQUESTER_ID, ['employee']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    schemaVersion: 2,
    expectedVersion: 1,
    proposed: nextDraft,
  });
  assert.deepEqual(Object.keys(result).sort(), ['change', 'requestRef']);
  assert.deepEqual(result.change.proposedRequest, toPublicRequest(appliedRequest));
  assert.deepEqual(result.requestRef, {
    id: 'CR-68', schemaVersion: 2, version: 2, status: 'Confirmed',
  });
});

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
    schemaVersion: 2,
    expectedVersion: 1,
    proposed: proposed({ startsAt: request().startsAt, endsAt: request().endsAt }),
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
    schemaVersion: 2,
    expectedVersion: 1,
    proposed: proposed(),
  }), (error) => error instanceof BookingChangeConflictError
    && error.code === 'BOOKING_CHANGE_OPEN_EXISTS');
});

test('a stale proposal version conflicts before current-state no-op classification', async () => {
  const baseDraft = proposed({
    startsAt: '2026-09-01T08:00:00.000Z',
    endsAt: '2026-09-01T09:00:00.000Z',
    internalParticipants: 2,
  });
  const current = request({
    schemaVersion: 2,
    version: 2,
    snapshot: v2Snapshot(baseDraft, 2),
  });
  const { instance, calls } = service({ current });
  await assert.rejects(instance.propose({
    principal: principal(REQUESTER_ID, ['employee']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    schemaVersion: 2,
    expectedVersion: 1,
    proposed: baseDraft,
  }), BookingChangeConflictError);
  await assert.rejects(instance.propose({
    principal: principal(REQUESTER_ID, ['employee']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    schemaVersion: 2,
    expectedVersion: Number.MAX_SAFE_INTEGER,
    proposed: baseDraft,
  }), /REQUEST_VERSION_INVALID/);
  assert.deepEqual(calls, []);
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
  assert.equal(result.change.status, 'applied');
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'calendar-update', 'finish']);
});

test('v2 composition-only approval applies its immutable snapshot without a calendar mutation', async () => {
  const baseDraft = proposed({
    startsAt: '2026-09-01T08:00:00.000Z',
    endsAt: '2026-09-01T09:00:00.000Z',
    internalParticipants: 2,
  });
  const current = request({
    schemaVersion: 2,
    version: 1,
    snapshot: v2Snapshot(baseDraft, 1),
  });
  const nextDraft = proposed({
    startsAt: current.startsAt,
    endsAt: current.endsAt,
    internalParticipants: current.internalParticipants,
    specialRequirements: 'Updated room layout',
  });
  const pending = change({
    requestSchemaVersion: 2,
    baseRequestVersion: 1,
    requestDraft: nextDraft,
    proposedRequestSnapshot: v2Snapshot(nextDraft, 2),
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
  });
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin', values]);
        return {
          status: 'applying',
          change: normalizeBookingChange({
            ...pending,
            status: 'applying',
            decidedByUserId: MANAGER_ID,
          }),
          request: current,
        };
      },
    },
  });
  const result = await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(result.change.status, 'applied');
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'finish']);
});

test('approval resumes a persisted applying proposal with its stable attempt identity', async () => {
  const { current, nextDraft, pending } = v2PendingChange({
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
  });
  const applying = normalizeBookingChange({
    ...pending,
    status: 'applying',
    decidedByUserId: MANAGER_ID,
    moveAttemptNumber: 1,
    recoveryPhase: 'move_pending',
  });
  const appliedChange = normalizeBookingChange({
    ...applying,
    status: 'applied',
    recoveryPhase: 'none',
  });
  const appliedRequest = normalizeRequest({
    ...current,
    version: 2,
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
    updatedAt: '2026-08-26T10:00:02.000Z',
    snapshot: pending.proposedRequestSnapshot,
  });
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin-resume', values]);
        return { status: 'applying', change: applying, request: current };
      },
      async finishApproval(values) {
        calls.push(['finish', values]);
        return { status: 'applied', change: appliedChange, request: appliedRequest };
      },
    },
  });
  const result = await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(result.change.status, 'applied');
  assert.deepEqual(calls.map(([name]) => name), ['begin-resume', 'calendar-update', 'finish']);
});

test('already-applied approval replay returns persisted state without repeating provider work', async () => {
  const { current, nextDraft, pending } = v2PendingChange({
    specialRequirements: 'Updated room layout',
  });
  const appliedChange = normalizeBookingChange({ ...pending, status: 'applied' });
  const appliedRequest = normalizeRequest({
    ...current,
    version: 2,
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
    snapshot: pending.proposedRequestSnapshot,
  });
  const { instance, calls } = service({
    current: appliedRequest,
    repository: {
      async beginApproval(values) {
        calls.push(['begin-replay', values]);
        return { status: 'applied', change: appliedChange, request: appliedRequest };
      },
    },
  });
  const result = await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(result.change.status, 'applied');
  assert.deepEqual(result.change.proposedRequest, toPublicRequest(appliedRequest));
  assert.deepEqual(calls.map(([name]) => name), ['begin-replay']);
});

test('unknown finish response rereads committed state and never rolls back an applied room move', async () => {
  const { current, nextDraft, pending } = v2PendingChange({ roomId: 'room-2' });
  const applying = normalizeBookingChange({
    ...pending,
    status: 'applying',
    decidedByUserId: MANAGER_ID,
    moveAttemptNumber: 1,
    recoveryPhase: 'move_pending',
  });
  const appliedChange = normalizeBookingChange({
    ...applying,
    status: 'applied',
    recoveryPhase: 'none',
  });
  const appliedRequest = normalizeRequest({
    ...current,
    version: 2,
    roomId: nextDraft.roomId,
    startsAt: nextDraft.startsAt,
    endsAt: nextDraft.endsAt,
    internalParticipants: nextDraft.internalParticipants,
    externalParticipants: nextDraft.externalParticipants,
    updatedAt: '2026-08-26T10:00:02.000Z',
    snapshot: pending.proposedRequestSnapshot,
  });
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin', values]);
        return { status: 'applying', change: applying, request: current };
      },
      async finishApproval(values) {
        calls.push(['finish-committed', values]);
        throw new Error('CONNECTION_LOST_AFTER_COMMIT');
      },
      async findApprovalState(values) {
        calls.push(['reconcile', values]);
        return { status: 'applied', change: appliedChange, request: appliedRequest };
      },
    },
    bookingFactory: {
      async moveCalendarEvent(...args) {
        calls.push(['move', args]);
        return movedCalendarResult();
      },
      async rollbackCalendarMove() { calls.push(['rollback']); },
    },
  });
  const result = await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(result.change.status, 'applied');
  assert.deepEqual(calls.map(([name]) => name), [
    'begin', 'move', 'record-target', 'finish-committed', 'reconcile',
  ]);
  assert.equal(calls.find(([name]) => name === 'move')[1][4], 1);
});

test('v2 booking-change records reject draft, snapshot and scalar disagreement', () => {
  const { pending } = v2PendingChange({ specialRequirements: 'Updated room layout' });
  const mismatchedSnapshot = structuredClone(pending);
  mismatchedSnapshot.proposedRequestSnapshot.details.title = 'Different persisted proposal';
  assert.throws(() => normalizeBookingChange(mismatchedSnapshot), /BOOKING_CHANGE_INVALID/);

  assert.throws(() => normalizeBookingChange({
    ...pending,
    internalParticipants: pending.internalParticipants + 1,
  }), /BOOKING_CHANGE_INVALID/);
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
      return {
        status: 'blocked', alternatives: ['room-2', 'room-3'], change: change(), request: request(),
      };
    },
  } });
  const result = await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.alternatives, ['room-2', 'room-3']);
  assert.equal(result.change.status, 'pending');
  assert.deepEqual(result.requestRef, {
    id: 'CR-68', schemaVersion: 1, version: 1, status: 'Confirmed',
  });
  assert.deepEqual(calls.map(([name]) => name), ['begin']);
});

test('finish-time availability race compensates the calendar and returns blocked alternatives', async () => {
  const current = request();
  const { instance, calls } = service({
    current,
    repository: {
      async finishApproval(values) {
        calls.push(['finish', values]);
        return { status: 'blocked' };
      },
    },
    booking: {
      async updateCalendarEvent(bookingContext) {
        calls.push([
          bookingContext.request.startsAt === current.startsAt
            ? 'calendar-restore'
            : 'calendar-update',
        ]);
        return { state: 'active' };
      },
    },
  });
  const result = await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.alternatives, ['room-2']);
  assert.equal(result.change.status, 'pending');
  assert.deepEqual(result.requestRef, {
    id: 'CR-68', schemaVersion: 1, version: 1, status: 'Confirmed',
  });
  assert.deepEqual(calls.map(([name]) => name), [
    'begin', 'calendar-update', 'finish', 'calendar-restore', 'pending',
  ]);
  assert.equal(calls.at(-1)[1].auditEvent.metadata.operation, 'approve_blocked');
});

test('approval never reports blocked when returning the proposal to pending did not persist', async () => {
  const current = request();
  const { instance, calls } = service({
    current,
    repository: {
      async finishApproval(values) {
        calls.push(['finish', values]);
        return { status: 'blocked' };
      },
      async returnToPending(values) {
        calls.push(['pending-missed', values]);
        return null;
      },
    },
    booking: {
      async updateCalendarEvent(bookingContext) {
        calls.push([
          bookingContext.request.startsAt === current.startsAt
            ? 'calendar-restore'
            : 'calendar-update',
        ]);
        return { state: 'active' };
      },
    },
  });
  await assert.rejects(instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  }), (error) => error instanceof BookingChangeDependencyError
    && error.code === 'BOOKING_CHANGE_RECONCILIATION_REQUIRED');
  assert.deepEqual(calls.map(([name]) => name), [
    'begin', 'calendar-update', 'finish', 'calendar-restore', 'pending-missed',
  ]);
});

test('room move validates and audits its replacement before atomic application', async () => {
  const { current, pending } = v2PendingChange({ roomId: 'room-2' });
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin', values]);
        return {
          status: 'applying',
          change: normalizeBookingChange({
            ...pending,
            status: 'applying',
            decidedByUserId: MANAGER_ID,
          }),
          request: current,
        };
      },
    },
    bookingFactory: {
      async moveCalendarEvent() {
        calls.push(['move']);
        return movedCalendarResult();
      },
    },
  });
  assert.equal((await instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  })).change.status, 'applied');
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'move', 'record-target', 'finish']);
  assert.deepEqual(calls.at(-1)[1].calendarReplacement, movedCalendarResult().replacement);
});

test('room-move target-state failure enters durable reconciliation without guessing provider state', async () => {
  const { current, pending } = v2PendingChange({ roomId: 'room-2' });
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin', values]);
        return {
          status: 'applying',
          change: normalizeBookingChange({
            ...pending,
            status: 'applying',
            decidedByUserId: MANAGER_ID,
          }),
          request: current,
        };
      },
      async recordCalendarMoveTarget(values) {
        calls.push(['record-target-failed', values]);
        throw new Error('EXPECTED_TARGET_STATE_FAILURE');
      },
    },
    bookingFactory: {
      async moveCalendarEvent() {
        calls.push(['move']);
        return movedCalendarResult();
      },
      async rollbackCalendarMove() { calls.push(['rollback']); },
    },
  });
  await assert.rejects(instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  }), (error) => error instanceof BookingChangeDependencyError
    && error.code === 'BOOKING_CHANGE_RECONCILIATION_REQUIRED');
  assert.deepEqual(calls.map(([name]) => name), [
    'begin', 'move', 'record-target-failed', 'reconciliation-required',
  ]);
});

test('malformed room-move success cannot apply without a validated provider-reference swap', async () => {
  const { current, pending } = v2PendingChange({ roomId: 'room-2' });
  const malformedMove = { status: 'moved', rollback: { opaque: true } };
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin', values]);
        return {
          status: 'applying',
          change: normalizeBookingChange({
            ...pending,
            status: 'applying',
            decidedByUserId: MANAGER_ID,
          }),
          request: current,
        };
      },
    },
    bookingFactory: {
      async moveCalendarEvent() {
        calls.push(['move']);
        return malformedMove;
      },
      async rollbackCalendarMove(...args) { calls.push(['rollback', args]); },
    },
  });
  await assert.rejects(instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  }), BookingChangeDependencyError);
  assert.deepEqual(calls.map(([name]) => name), [
    'begin', 'move', 'reconciliation-required',
  ]);
  assert.equal(calls.some(([name]) => name === 'rollback'), false);
  assert.equal(calls.some(([name]) => name === 'finish'), false);
});

test('a thrown room-move call performs no outer rollback when the factory owns cleanup', async () => {
  const { current, pending } = v2PendingChange({ roomId: 'room-2' });
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin', values]);
        return {
          status: 'applying',
          change: normalizeBookingChange({
            ...pending,
            status: 'applying',
            decidedByUserId: MANAGER_ID,
          }),
          request: current,
        };
      },
    },
    bookingFactory: {
      async moveCalendarEvent() {
        calls.push(['move']);
        throw new Error('FACTORY_CLEANED_TARGET');
      },
      async rollbackCalendarMove() { calls.push(['rollback']); },
    },
  });
  await assert.rejects(instance.approve({
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  }), BookingChangeDependencyError);
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'move', 'audit', 'pending']);
});

test('unknown target-create outcome stays applying so retry retains the same move attempt', async () => {
  const { current, pending } = v2PendingChange({ roomId: 'room-2' });
  const applying = normalizeBookingChange({
    ...pending,
    status: 'applying',
    decidedByUserId: MANAGER_ID,
    moveAttemptNumber: 1,
    recoveryPhase: 'move_pending',
  });
  const attempts = [];
  const { instance, calls } = service({
    current,
    repository: {
      async beginApproval(values) {
        calls.push(['begin-resume', values]);
        return { status: 'applying', change: applying, request: current };
      },
    },
    bookingFactory: {
      async moveCalendarEvent(...args) {
        calls.push(['move']);
        attempts.push(args[4]);
        throw new BookingChangeCalendarMoveError(
          BOOKING_CHANGE_MOVE_RECOVERY.RETRY_SAME_ATTEMPT,
        );
      },
    },
  });
  const input = {
    principal: principal(MANAGER_ID, ['conference_manager']),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    requestId: 'CR-68',
    changeId: CHANGE_ID,
  };
  await assert.rejects(instance.approve(input), BookingChangeDependencyError);
  await assert.rejects(instance.approve(input), BookingChangeDependencyError);
  assert.deepEqual(attempts, [1, 1]);
  assert.equal(calls.some(([name]) => name === 'pending'), false);
  assert.equal(calls.some(([name]) => name === 'rollback'), false);
});


test('v3 booking changes reject empty and hybrid proposals and expose immutable Equipment', async () => {
  const baseDraft = proposed({
    startsAt: '2026-09-01T08:00:00.000Z', endsAt: '2026-09-01T09:00:00.000Z',
    internalParticipants: 2, equipmentIds: ['display'],
  });
  const current = request({ schemaVersion: 3, version: 1, snapshot: v2Snapshot(baseDraft, 1, 3) });
  let persisted = null;
  const { instance, calls } = service({ current, repository: {
    async propose(values) {
      calls.push(['propose-v3', values]);
      persisted = change({
        requestSchemaVersion: values.schemaVersion, requestDraft: values.proposal, baseRequestVersion: 1,
        proposedRequestSnapshot: v2Snapshot(values.proposal, 2, values.schemaVersion),
        roomId: values.proposal.roomId, startsAt: values.proposal.startsAt, endsAt: values.proposal.endsAt,
        internalParticipants: values.proposal.internalParticipants,
        externalParticipants: values.proposal.externalParticipants,
      });
      return { status: 'pending', change: persisted, request: current };
    },
    async findOpen() { return persisted; },
  } });
  const context = {
    principal: principal(REQUESTER_ID, ['employee']), tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID, requestId: 'CR-68', expectedVersion: 1,
  };
  await assert.rejects(instance.propose({ ...context, schemaVersion: 3, proposed: baseDraft }),
    { code: 'BOOKING_CHANGE_EMPTY' });
  await assert.rejects(instance.propose({ ...context, schemaVersion: 2, proposed: baseDraft }));
  const { equipmentIds, ...v2Draft } = baseDraft;
  assert.equal(equipmentIds.length, 1);
  await assert.rejects(instance.propose({ ...context, schemaVersion: 3, proposed: v2Draft }));
  assert.equal(calls.length, 0);
  const result = await instance.propose({ ...context, schemaVersion: 3,
    proposed: { ...baseDraft, equipmentIds: ['projector'] } });
  assert.equal(calls[0][1].schemaVersion, 3);
  assert.equal(result.change.requestSchemaVersion, 3);
  assert.deepEqual(result.change.proposedRequest.details.equipmentIds, ['projector']);
  assert.equal(result.change.proposedRequest.pricing.equipment[0].equipment.name, 'Equipment projector');
  assert.deepEqual(current.snapshot.details.equipmentIds, ['display']);
  assert.deepEqual((await instance.findOpen(context)).change, result.change);
});
