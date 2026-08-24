import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantUserAdministrationService } from '../src/application/tenant-user-administration-service.js';
import { TenantUserRoleConflictError } from '../src/application/tenant-user-errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';

function principal(overrides = {}) {
  return {
    userId: ADMIN_ID,
    tenantId: TENANT_ID,
    roles: ['employee', 'tenant_admin'],
    permissions: [
      'request:read',
      'request:cancel',
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ],
    ...overrides,
  };
}

const tenantContext = Object.freeze({ tenantId: TENANT_ID, status: 'onboarding' });

function auditService(capture = {}) {
  return {
    createEvent(value) {
      capture.created?.push(value);
      return Object.freeze({ ...value });
    },
    async record(value) {
      capture.recorded?.push(value);
      return value;
    },
    async recordAuthorizationDenied(value) {
      capture.denied?.push(value);
      return value;
    },
  };
}

function repository(overrides = {}) {
  return {
    async listByTenantId() {
      return [{
        tenantId: TENANT_ID,
        userId: TARGET_ID,
        displayName: 'Conference User',
        active: true,
        securityVersion: 1,
        elevatedRoles: ['conference_manager'],
      }];
    },
    async setElevatedRoles(value) {
      const auditEvent = value.auditEventFor({
        previousElevatedRoles: [],
        nextElevatedRoles: value.elevatedRoles,
      });
      return {
        status: 'updated',
        auditEvent,
        user: {
          tenantId: TENANT_ID,
          userId: TARGET_ID,
          displayName: 'Conference User',
          active: true,
          securityVersion: 2,
          elevatedRoles: value.elevatedRoles,
        },
      };
    },
    ...overrides,
  };
}

function service({ repositoryValue, capture } = {}) {
  return createTenantUserAdministrationService({
    repository: repositoryValue || repository(),
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: auditService(capture),
    clock: () => Date.parse('2026-08-24T15:30:00.000Z'),
  });
}

test('Tenant Admin can list only tenant-scoped users with effective Employee baseline', async () => {
  let query;
  const value = service({
    repositoryValue: repository({
      async listByTenantId(input) {
        query = input;
        return [{
          tenantId: TENANT_ID,
          userId: TARGET_ID,
          displayName: 'Conference User',
          active: true,
          securityVersion: 3,
          elevatedRoles: ['conference_manager', 'tenant_admin'],
        }];
      },
    }),
  });
  const users = await value.listUsers({
    principal: principal(),
    tenantContext,
    correlationId: CORRELATION_ID,
    limit: 25,
  });
  assert.deepEqual(query, { tenantId: TENANT_ID, limit: 25, afterUserId: null });
  assert.deepEqual(users, [{
    id: TARGET_ID,
    displayName: 'Conference User',
    active: true,
    roles: ['employee', 'conference_manager', 'tenant_admin'],
  }]);
});

test('Employee cannot list or mutate tenant roles and denial is audited', async () => {
  const capture = { denied: [] };
  const employee = principal({
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  });
  const value = service({ capture });
  await assert.rejects(
    value.listUsers({
      principal: employee,
      tenantContext,
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    value.setRoles({
      principal: employee,
      tenantContext,
      targetUserId: TARGET_ID,
      roles: ['conference_manager'],
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(capture.denied.length, 2);
});

test('Tenant Admin role mutation is exact, audited and keeps Employee baseline', async () => {
  let input;
  const capture = { created: [] };
  const value = service({
    capture,
    repositoryValue: repository({
      async setElevatedRoles(valueToPersist) {
        input = valueToPersist;
        const auditEvent = valueToPersist.auditEventFor({
          previousElevatedRoles: [],
          nextElevatedRoles: valueToPersist.elevatedRoles,
        });
        assert.deepEqual(auditEvent.previousState, {
          conferenceManager: false,
          tenantAdmin: false,
        });
        assert.deepEqual(auditEvent.newState, {
          conferenceManager: true,
          tenantAdmin: true,
        });
        return {
          status: 'updated',
          user: {
            tenantId: TENANT_ID,
            userId: TARGET_ID,
            displayName: 'Conference User',
            active: true,
            securityVersion: 2,
            elevatedRoles: valueToPersist.elevatedRoles,
          },
        };
      },
    }),
  });
  const updated = await value.setRoles({
    principal: principal(),
    tenantContext,
    targetUserId: TARGET_ID,
    roles: ['tenant_admin', 'conference_manager'],
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(input.elevatedRoles, ['conference_manager', 'tenant_admin']);
  assert.deepEqual(updated.roles, ['employee', 'conference_manager', 'tenant_admin']);
  assert.equal(capture.created[0].action, 'tenant.user_permissions.changed');
  assert.equal(capture.created[0].actorUserId, ADMIN_ID);
  assert.equal(capture.created[0].targetId, TARGET_ID);
});

test('Tenant Admin cannot change own elevated roles', async () => {
  const capture = { denied: [] };
  const value = service({ capture });
  await assert.rejects(
    value.setRoles({
      principal: principal(),
      tenantContext,
      targetUserId: ADMIN_ID,
      roles: ['conference_manager', 'tenant_admin'],
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof AuthorizationDeniedError
      && error.code === 'SELF_ROLE_CHANGE_NOT_AUTHORIZED',
  );
  assert.equal(capture.denied.at(-1).metadata.operation, 'self_role_change');
});

test('last Tenant Admin and inactive target conflicts are explicit and audited', async () => {
  for (const [status, code] of [
    ['last_tenant_admin', 'LAST_TENANT_ADMIN_REQUIRED'],
    ['user_inactive', 'TENANT_USER_INACTIVE'],
  ]) {
    const capture = { recorded: [] };
    const value = service({
      capture,
      repositoryValue: repository({
        async setElevatedRoles() { return { status }; },
      }),
    });
    await assert.rejects(
      value.setRoles({
        principal: principal(),
        tenantContext,
        targetUserId: TARGET_ID,
        roles: [],
        correlationId: CORRELATION_ID,
      }),
      (error) => error instanceof TenantUserRoleConflictError && error.code === code,
    );
    assert.equal(capture.recorded[0].action, 'tenant.user_permissions.changed');
    assert.equal(capture.recorded[0].outcome, 'failure');
  }
});

test('unknown target is concealed and invalid elevated roles fail before persistence', async () => {
  let writes = 0;
  const capture = { denied: [] };
  const value = service({
    capture,
    repositoryValue: repository({
      async setElevatedRoles() {
        writes += 1;
        return { status: 'not_found' };
      },
    }),
  });
  await assert.rejects(
    value.setRoles({
      principal: principal(),
      tenantContext,
      targetUserId: TARGET_ID,
      roles: ['conference_manager'],
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof AuthorizationDeniedError && error.conceal === true,
  );
  assert.equal(writes, 1);
  assert.equal(capture.denied.length, 1);

  for (const roles of [['platform_admin'], ['employee'], ['tenant_admin', 'tenant_admin']]) {
    await assert.rejects(value.setRoles({
      principal: principal(),
      tenantContext,
      targetUserId: TARGET_ID,
      roles,
      correlationId: CORRELATION_ID,
    }));
  }
  assert.equal(writes, 1);
});
