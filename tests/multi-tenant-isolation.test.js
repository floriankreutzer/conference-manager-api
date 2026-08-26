import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOKING_OPERATION,
  createAuthorizationPolicy,
  tenantAuthorizationSnapshot,
} from '../src/authorization/policy.js';
import { createEntitlementService } from '../src/entitlements/entitlement-service.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

function principal(tenantId, userId, roles) {
  const snapshot = tenantAuthorizationSnapshot(roles);
  return Object.freeze({
    tenantId,
    userId,
    roles: snapshot.roles,
    permissions: snapshot.permissions,
  });
}

const policy = createAuthorizationPolicy();
const tenantA = Object.freeze({ tenantId: TENANT_A, status: 'active' });
const tenantB = Object.freeze({ tenantId: TENANT_B, status: 'active' });
const employeeA = principal(TENANT_A, USER_A, ['employee']);
const managerA = principal(TENANT_A, USER_A, ['conference_manager']);
const adminA = principal(TENANT_A, USER_A, ['tenant_admin']);

function foreignRequest() {
  return Object.freeze({
    tenantId: TENANT_B,
    requesterUserId: USER_B,
    status: 'Submitted',
  });
}

test('request read, transition and booking operations conceal foreign Tenant resources', () => {
  assert.throws(
    () => policy.authorizeRequestRead(managerA, tenantA, foreignRequest()),
    (error) => error?.code === 'RESOURCE_NOT_AVAILABLE' && error?.conceal === true,
  );
  assert.throws(
    () => policy.authorizeRequestTransition(managerA, tenantA, foreignRequest(), 'confirm'),
    (error) => error?.code === 'RESOURCE_NOT_AVAILABLE' && error?.conceal === true,
  );
  assert.throws(
    () => policy.authorizeBookingOperation(managerA, tenantA, foreignRequest(), BOOKING_OPERATION.CREATE),
    (error) => error?.code === 'RESOURCE_NOT_AVAILABLE' && error?.conceal === true,
  );
});

test('manipulated Tenant context cannot promote Employee, Manager or Tenant Admin access', () => {
  for (const actor of [employeeA, managerA, adminA]) {
    assert.throws(
      () => policy.authorizeTenantApplicationRead(actor, tenantB),
      (error) => error?.code === 'TENANT_SCOPE_INVALID',
    );
  }
});

test('Employee object ownership remains enforced within the correct Tenant', () => {
  const sameTenantOtherUser = Object.freeze({
    tenantId: TENANT_A,
    requesterUserId: USER_B,
    status: 'Submitted',
  });
  assert.throws(
    () => policy.authorizeRequestRead(employeeA, tenantA, sameTenantOtherUser),
    (error) => error?.code === 'RESOURCE_NOT_AVAILABLE' && error?.conceal === true,
  );
});

test('suspended Tenant cannot satisfy effective Microsoft entitlement access', async () => {
  const service = createEntitlementService({
    repository: {
      async findByTenantIdAndCapabilityId() { return { enabled: true }; },
      async changeByTenantIdAndCapabilityId() { throw new Error('NOT_USED'); },
    },
    auditService: {
      createActorEvent(value) { return value; },
    },
  });
  const allowed = await service.evaluateAccess({
    principal: employeeA,
    tenantContext: tenantA,
    capabilityId: 'microsoft.calendar',
    authorized: true,
  });
  const suspended = await service.evaluateAccess({
    principal: employeeA,
    tenantContext: { tenantId: TENANT_A, status: 'suspended' },
    capabilityId: 'microsoft.calendar',
    authorized: true,
  });
  const foreign = await service.evaluateAccess({
    principal: employeeA,
    tenantContext: tenantB,
    capabilityId: 'microsoft.calendar',
    authorized: true,
  });
  assert.equal(allowed, true);
  assert.equal(suspended, false);
  assert.equal(foreign, false);
});

test('unknown or client-selected capability state fails closed', async () => {
  const service = createEntitlementService({
    repository: {
      async findByTenantIdAndCapabilityId() { return { enabled: true }; },
      async changeByTenantIdAndCapabilityId() { throw new Error('NOT_USED'); },
    },
    auditService: {
      createActorEvent(value) { return value; },
    },
  });
  assert.equal(await service.evaluateAccess({
    principal: employeeA,
    tenantContext: tenantA,
    capabilityId: 'client.selected.capability',
    authorized: true,
  }), false);
});
