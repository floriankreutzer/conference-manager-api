import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestService } from '../src/application/request-service.js';
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

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '44444444-4444-4444-8444-444444444444';
const TENANT_A = '22222222-2222-4222-8222-222222222222';

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
  return {
    setConflict(value) {
      forceConflict = value;
    },
    async findByTenantIdAndId(tenantId, requestId) {
      if (!current || current.tenantId !== tenantId || current.id !== requestId) return null;
      return current;
    },
    async transitionByTenantIdAndId({ tenantId, requestId, expectedStatus, nextStatus, reason, changedAt }) {
      if (forceConflict || !current) return null;
      if (current.tenantId !== tenantId || current.id !== requestId || current.status !== expectedStatus) return null;
      current = {
        ...current,
        status: nextStatus,
        statusReason: reason,
        statusChangedAt: changedAt.toISOString(),
        updatedAt: changedAt.toISOString(),
      };
      return current;
    },
  };
}

function service(repository, clock = () => Date.parse('2026-08-24T09:00:00.000Z')) {
  return createRequestService({
    repository,
    authorizationPolicy: createAuthorizationPolicy(),
    clock,
  });
}

test('request service returns employee-owned resources and conceals cross-user resources', async () => {
  const own = service(fakeRepository());
  const tenantContext = { tenantId: TENANT_A };
  assert.equal((await own.getRequest({
    principal: principal(),
    tenantContext,
    requestId: 'REQ-1',
  })).id, 'REQ-1');

  const foreign = service(fakeRepository(requestRecord({ requesterUserId: USER_B })));
  await assert.rejects(
    foreign.getRequest({ principal: principal(), tenantContext, requestId: 'REQ-1' }),
    (error) => error instanceof AuthorizationDeniedError && error.conceal === true,
  );
});

test('request service rejects malformed and absent IDs without unscoped fallback lookup', async () => {
  const requestService = service(fakeRepository(null));
  const tenantContext = { tenantId: TENANT_A };
  await assert.rejects(
    requestService.getRequest({ principal: principal(), tenantContext, requestId: '../REQ-1' }),
    AuthorizationInputError,
  );
  await assert.rejects(
    requestService.getRequest({ principal: principal(), tenantContext, requestId: 'REQ-404' }),
    (error) => error instanceof AuthorizationDeniedError && error.conceal === true,
  );
});

test('authorized transitions persist only the server policy decision', async () => {
  const repository = fakeRepository();
  const requestService = service(repository);
  const updated = await requestService.transitionRequest({
    principal: principal(),
    tenantContext: { tenantId: TENANT_A },
    requestId: 'REQ-1',
    transition: REQUEST_TRANSITION.CANCEL,
  });
  assert.equal(updated.status, REQUEST_STATUS.CANCELLED);
  assert.equal(updated.statusReason, null);
  assert.equal(updated.updatedAt, '2026-08-24T09:00:00.000Z');
});

test('stale authorized transition fails with conflict instead of overwriting newer state', async () => {
  const repository = fakeRepository();
  repository.setConflict(true);
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  await assert.rejects(
    service(repository).transitionRequest({
      principal: manager,
      tenantContext: { tenantId: TENANT_A },
      requestId: 'REQ-1',
      transition: REQUEST_TRANSITION.CONFIRM,
    }),
    RequestStateConflictError,
  );
});
