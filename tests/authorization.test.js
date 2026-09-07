import assert from 'node:assert/strict';
import test from 'node:test';
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
const TENANT_B = '33333333-3333-4333-8333-333333333333';

function principal({
  userId = USER_A,
  tenantId = TENANT_A,
  roles = [TENANT_ROLE.EMPLOYEE],
  permissions = [PERMISSION.REQUEST_READ],
} = {}) {
  return { userId, tenantId, roles, permissions };
}

function context(tenantId = TENANT_A) {
  return { tenantId };
}

function request({
  tenantId = TENANT_A,
  requesterUserId = USER_A,
  status = REQUEST_STATUS.SUBMITTED,
} = {}) {
  return { tenantId, requesterUserId, status };
}

function isConcealed(error) {
  return error instanceof AuthorizationDeniedError && error.conceal === true;
}

test('employee request reads are owner-only and cross-user objects are concealed', () => {
  const policy = createAuthorizationPolicy();
  const employee = principal();
  assert.equal(policy.authorizeRequestRead(employee, context(), request()), true);
  assert.throws(
    () => policy.authorizeRequestRead(employee, context(), request({ requesterUserId: USER_B })),
    isConcealed,
  );
  assert.throws(
    () => policy.authorizeRequestRead(employee, context(), request({ tenantId: TENANT_B })),
    isConcealed,
  );
});

test('conference manager reads any request only inside the authenticated tenant', () => {
  const policy = createAuthorizationPolicy();
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  assert.equal(
    policy.authorizeRequestRead(manager, context(), request({ requesterUserId: USER_B })),
    true,
  );
  assert.throws(
    () => policy.authorizeRequestRead(manager, context(), request({ tenantId: TENANT_B })),
    isConcealed,
  );
});

test('tenant admin permissions do not imply conference-manager request access', () => {
  const policy = createAuthorizationPolicy();
  const tenantAdmin = principal({
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [
      PERMISSION.TENANT_CONFIGURE,
      PERMISSION.TENANT_USERS_MANAGE,
      PERMISSION.TENANT_INTEGRATIONS_MANAGE,
    ],
  });
  assert.equal(policy.requireTenantPermission(tenantAdmin, context(), PERMISSION.TENANT_CONFIGURE), true);
  assert.throws(
    () => policy.requireTenantPermission(tenantAdmin, context(TENANT_B), PERMISSION.TENANT_CONFIGURE),
    AuthorizationDeniedError,
  );
  assert.throws(
    () => policy.authorizeRequestRead(tenantAdmin, context(), request()),
    AuthorizationDeniedError,
  );
});

test('unknown roles, platform role, and unknown permissions fail the complete principal closed', () => {
  const policy = createAuthorizationPolicy();
  for (const roles of [['unknown_role'], ['platform_admin'], [TENANT_ROLE.EMPLOYEE, 'unknown_role']]) {
    assert.throws(
      () => policy.assertRecognizedPrincipal(principal({ roles })),
      AuthorizationDeniedError,
    );
  }
  assert.throws(
    () => policy.assertRecognizedPrincipal(principal({
      permissions: [PERMISSION.REQUEST_READ, 'request:superuser'],
    })),
    AuthorizationDeniedError,
  );
});

test('role and permission must both authorize the capability', () => {
  const policy = createAuthorizationPolicy();
  assert.throws(
    () => policy.authorizeRequestRead(principal({ permissions: [] }), context(), request()),
    AuthorizationDeniedError,
  );
  assert.throws(
    () => policy.authorizeRequestRead(principal({
      roles: [TENANT_ROLE.TENANT_ADMIN],
      permissions: [PERMISSION.REQUEST_READ],
    }), context(), request()),
    AuthorizationDeniedError,
  );
});

test('booking-change policy separates owner, manager, Tenant Admin and Tenant scope', () => {
  const policy = createAuthorizationPolicy();
  const employee = principal({
    userId: USER_B,
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
  });
  const tenantAdmin = principal({
    userId: USER_B,
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.TENANT_ADMIN],
    permissions: [
      PERMISSION.REQUEST_READ,
      PERMISSION.REQUEST_CANCEL,
      PERMISSION.TENANT_CONFIGURE,
    ],
  });
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });
  const confirmed = request({ status: REQUEST_STATUS.CONFIRMED });

  assert.throws(
    () => policy.authorizeBookingChangePropose(employee, context(), confirmed),
    isConcealed,
  );
  assert.throws(
    () => policy.authorizeBookingChangePropose(tenantAdmin, context(), confirmed),
    isConcealed,
  );
  assert.equal(
    policy.authorizeBookingChangePropose(manager, context(), confirmed),
    true,
  );
  assert.equal(
    policy.authorizeBookingChangeDecision(manager, context(), confirmed),
    true,
  );

  const crossTenant = request({
    tenantId: TENANT_B,
    status: REQUEST_STATUS.CONFIRMED,
  });
  assert.throws(
    () => policy.authorizeBookingChangePropose(manager, context(), crossTenant),
    isConcealed,
  );
  assert.throws(
    () => policy.authorizeBookingChangeDecision(manager, context(), crossTenant),
    isConcealed,
  );
});

test('conference-manager workflow transitions are explicit and state-aware', () => {
  const policy = createAuthorizationPolicy();
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_MANAGE],
  });

  const startReview = policy.authorizeRequestTransition(
    manager,
    context(),
    request(),
    REQUEST_TRANSITION.START_REVIEW,
  );
  assert.equal(startReview.nextStatus, REQUEST_STATUS.IN_REVIEW);

  const confirm = policy.authorizeRequestTransition(
    manager,
    context(),
    request({ status: REQUEST_STATUS.IN_REVIEW }),
    REQUEST_TRANSITION.CONFIRM,
  );
  assert.equal(confirm.nextStatus, REQUEST_STATUS.CONFIRMED);

  const reject = policy.authorizeRequestTransition(
    manager,
    context(),
    request({ status: REQUEST_STATUS.IN_REVIEW }),
    REQUEST_TRANSITION.REJECT,
    '  No suitable room  ',
  );
  assert.equal(reject.nextStatus, REQUEST_STATUS.REJECTED);
  assert.equal(reject.reason, 'No suitable room');

  const change = policy.authorizeRequestTransition(
    manager,
    context(),
    request(),
    REQUEST_TRANSITION.REQUEST_CHANGE,
    'Please adjust participant count',
  );
  assert.equal(change.nextStatus, REQUEST_STATUS.CHANGE_REQUESTED);
});

test('workflow transitions reject missing reasons, injected reasons, invalid states, and wrong roles', () => {
  const policy = createAuthorizationPolicy();
  const manager = principal({
    roles: [TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_MANAGE],
  });
  const employee = principal({
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
  });

  assert.throws(
    () => policy.authorizeRequestTransition(manager, context(), request(), REQUEST_TRANSITION.REJECT),
    AuthorizationInputError,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(
      manager,
      context(),
      request(),
      REQUEST_TRANSITION.CONFIRM,
      'client-supplied reason',
    ),
    AuthorizationInputError,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(
      manager,
      context(),
      request({ status: REQUEST_STATUS.CONFIRMED }),
      REQUEST_TRANSITION.REJECT,
      'Too late',
    ),
    RequestStateConflictError,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(employee, context(), request(), REQUEST_TRANSITION.CONFIRM),
    AuthorizationDeniedError,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(manager, context(), request(), 'set_status'),
    AuthorizationInputError,
  );
});

test('conference manager cancellation covers eligible same-Tenant Requests without Employee ownership', () => {
  const policy = createAuthorizationPolicy();
  const manager = principal({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [
      PERMISSION.REQUEST_READ,
      PERMISSION.REQUEST_CANCEL,
      PERMISSION.REQUEST_MANAGE,
    ],
  });
  for (const status of [
    REQUEST_STATUS.SUBMITTED,
    REQUEST_STATUS.IN_REVIEW,
    REQUEST_STATUS.CONFIRMED,
    REQUEST_STATUS.CHANGE_REQUESTED,
  ]) {
    const decision = policy.authorizeRequestTransition(
      manager,
      context(),
      request({ requesterUserId: USER_B, status }),
      REQUEST_TRANSITION.CANCEL,
    );
    assert.deepEqual(decision, {
      transition: REQUEST_TRANSITION.CANCEL,
      expectedStatus: status,
      nextStatus: REQUEST_STATUS.CANCELLED,
      reason: null,
    });
  }

  assert.throws(
    () => policy.authorizeRequestTransition(
      manager,
      context(),
      request({ tenantId: TENANT_B, requesterUserId: USER_B }),
      REQUEST_TRANSITION.CANCEL,
    ),
    isConcealed,
  );
  const managerWithoutPermission = principal({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
  });
  assert.throws(
    () => policy.authorizeRequestTransition(
      managerWithoutPermission,
      context(),
      request({ requesterUserId: USER_B }),
      REQUEST_TRANSITION.CANCEL,
    ),
    isConcealed,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(
      manager,
      context(),
      request({ requesterUserId: USER_B, status: REQUEST_STATUS.REJECTED }),
      REQUEST_TRANSITION.CANCEL,
    ),
    RequestStateConflictError,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(
      manager,
      context(),
      request({ requesterUserId: USER_B }),
      REQUEST_TRANSITION.CANCEL,
      'client reason',
    ),
    AuthorizationInputError,
  );
});

test('Tenant Admin cannot inherit tenant-wide cancellation from an injected manager permission', () => {
  const policy = createAuthorizationPolicy();
  const tenantAdmin = principal({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.TENANT_ADMIN],
    permissions: [
      PERMISSION.REQUEST_READ,
      PERMISSION.REQUEST_CANCEL,
      PERMISSION.REQUEST_MANAGE,
      PERMISSION.TENANT_CONFIGURE,
    ],
  });
  assert.throws(
    () => policy.authorizeRequestTransition(
      tenantAdmin,
      context(),
      request({ requesterUserId: USER_B }),
      REQUEST_TRANSITION.CANCEL,
    ),
    isConcealed,
  );
  assert.equal(
    policy.authorizeRequestTransition(
      tenantAdmin,
      context(),
      request(),
      REQUEST_TRANSITION.CANCEL,
    ).nextStatus,
    REQUEST_STATUS.CANCELLED,
  );
});

test('employee cancellation is owner-bound and limited to eligible states', () => {
  const policy = createAuthorizationPolicy();
  const employee = principal({
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
  });
  for (const status of [
    REQUEST_STATUS.SUBMITTED,
    REQUEST_STATUS.IN_REVIEW,
    REQUEST_STATUS.CONFIRMED,
    REQUEST_STATUS.CHANGE_REQUESTED,
  ]) {
    const decision = policy.authorizeRequestTransition(
      employee,
      context(),
      request({ status }),
      REQUEST_TRANSITION.CANCEL,
    );
    assert.equal(decision.expectedStatus, status);
    assert.equal(decision.nextStatus, REQUEST_STATUS.CANCELLED);
  }

  assert.throws(
    () => policy.authorizeRequestTransition(
      employee,
      context(),
      request({ requesterUserId: USER_B }),
      REQUEST_TRANSITION.CANCEL,
    ),
    isConcealed,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(
      employee,
      context(),
      request({ status: REQUEST_STATUS.REJECTED }),
      REQUEST_TRANSITION.CANCEL,
    ),
    RequestStateConflictError,
  );
});
