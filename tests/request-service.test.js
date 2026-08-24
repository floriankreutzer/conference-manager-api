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

function fakeRepository(initial = requestRecord()) {
  let current = initial;
  let forceConflict = false;
  const committedAuditEvents = [];
  return {
    committedAuditEvents,
    setConflict(value) {
      forceConflict = value;
    },
    async findByTenantIdAndId(tenantId, requestId) {
      if (!current || current.tenantId !== tenantId || current.id !== requestId) return null;
      return current;
    },
    async transitionByTenantIdAndId({
      tenantId,
      requestId,
      expectedStatus,
      nextStatus,
      reason,
      changedAt,
      auditEvent,
    }) {
      if (forceConflict || !current) return null;
      if (current.tenantId !== tenantId || current.id !== requestId || current.status !== expectedStatus) return null;
      current = {
        ...current,
        status: nextStatus,
        statusReason: reason,
        statusChangedAt: changedAt.toISOString(),
        updatedAt: changedAt.toISOString(),
      };
      committedAuditEvents.push(auditEvent);
      return current;
    },
  };
}

function service(repository, clock = () => Date.parse('2026-08-24T09:00:00.000Z')) {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy, clock });
  return Object.freeze({
    audit,
    requestService: createRequestService({
      repository,
      authorizationPolicy,
      auditService: audit.service,
      clock,
    }),
  });
}

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

test('authorized transitions carry only the server policy decision into the atomic audit contract', async () => {
  const repository = fakeRepository();
  const context = service(repository);
  const updated = await context.requestService.transitionRequest({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
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
  assert.equal(context.audit.events.length, 0);
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
      transition: REQUEST_TRANSITION.CONFIRM,
      correlationId: CORRELATION_ID,
    }),
    RequestStateConflictError,
  );
  assert.equal(repository.committedAuditEvents.length, 0);
  assert.equal(context.audit.events.length, 1);
  assert.equal(context.audit.events[0].action, AUDIT_ACTION.REQUEST_TRANSITION_FAILED);
  assert.equal(context.audit.events[0].metadata.reasonCode, 'concurrent_state_change');
  assert.equal(context.audit.events[0].correlationId, CORRELATION_ID);
});
