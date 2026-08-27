import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantUserLifecycleService } from '../src/application/tenant-user-lifecycle-service.js';
import { TenantUserLifecycleConflictError } from '../src/application/tenant-user-lifecycle-errors.js';
import { AuthorizationDeniedError, AuthorizationInputError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';

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

function storedUser(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    displayName: 'Managed User',
    active: true,
    securityVersion: 7,
    lifecycleVersion: 2,
    elevatedRoles: ['conference_manager'],
    identityLinked: true,
    identityLinkedAt: '2026-08-20T10:00:00.000Z',
    lastSignInAt: '2026-08-26T10:00:00.000Z',
    ownedOpenRequestCount: 3,
    ...overrides,
  };
}

function service(repository, overrides = {}) {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  return {
    audit,
    service: createTenantUserLifecycleService({
      repository,
      authorizationPolicy,
      auditService: audit.service,
      clock: () => Date.parse('2026-08-27T09:00:00.000Z'),
      ...overrides,
    }),
  };
}

test('Tenant User lifecycle listing is bounded, filtered, Tenant-scoped and presentation-safe', async () => {
  let received;
  const harness = service({
    async listByTenantId(values) {
      received = values;
      return [storedUser(), storedUser({
        userId: '66666666-6666-4666-8666-666666666666',
        displayName: 'Second User',
      })];
    },
    async changeAccess() {},
  });
  const page = await harness.service.listUsers({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    limit: 1,
    search: 'Managed',
    status: 'active',
    role: 'conference_manager',
    providerLink: 'linked',
  });
  assert.equal(received.tenantId, TENANT_ID);
  assert.equal(received.limit, 2);
  assert.equal(received.search, 'Managed');
  assert.equal(page.users.length, 1);
  assert.equal(page.nextAfterId, USER_ID);
  assert.deepEqual(page.users[0].roles, ['employee', 'conference_manager']);
  assert.deepEqual(page.users[0].lifecycle, { status: 'active', version: 2 });
  assert.deepEqual(page.users[0].identityProvider, {
    linked: true,
    linkedAt: '2026-08-20T10:00:00.000Z',
  });
  assert.deepEqual(page.users[0].requestOwnership, {
    openRequestCount: 3,
    ownershipPreservedOnDisable: true,
  });
  assert.equal(Object.hasOwn(page.users[0], 'securityVersion'), false);
  assert.equal(Object.hasOwn(page.users[0].identityProvider, 'reference'), false);
});

test('lifecycle changes are versioned and carry audit-atomic session and Request implications', async () => {
  let auditEvent;
  const harness = service({
    async listByTenantId() {
      return [];
    },
    async changeAccess(values) {
      assert.equal(values.tenantId, TENANT_ID);
      assert.equal(values.targetUserId, USER_ID);
      assert.equal(values.active, false);
      assert.equal(values.expectedVersion, 2);
      auditEvent = values.auditEventFor({
        previousActive: true,
        nextActive: false,
        previousVersion: 2,
        nextVersion: 3,
        openRequestCount: 3,
        revokedSessionCount: 2,
      });
      return {
        status: 'updated',
        user: storedUser({ active: false, lifecycleVersion: 3 }),
      };
    },
  });
  const result = await harness.service.setAccess({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    targetUserId: USER_ID,
    active: false,
    expectedVersion: 2,
    correlationId: CORRELATION_ID,
  });
  assert.equal(result.active, false);
  assert.deepEqual(result.lifecycle, { status: 'disabled', version: 3 });
  assert.equal(auditEvent.action, 'tenant.user_permissions.changed');
  assert.deepEqual(auditEvent.previousState, { active: true, lifecycleVersion: 2 });
  assert.deepEqual(auditEvent.newState, { active: false, lifecycleVersion: 3 });
  assert.deepEqual(auditEvent.metadata, {
    openRequestCount: 3,
    operation: 'disable',
    revokedSessionCount: 2,
  });
});

test('self-service, cross-Tenant targets, stale versions and last-admin removal fail closed', async () => {
  const outcomes = ['not_found', 'version_conflict', 'last_tenant_admin'];
  for (const status of outcomes) {
    const harness = service({
      async listByTenantId() {
        return [];
      },
      async changeAccess() {
        return { status, currentVersion: 4 };
      },
    });
    const operation = harness.service.setAccess({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      targetUserId: USER_ID,
      active: false,
      expectedVersion: 2,
      correlationId: CORRELATION_ID,
    });
    if (status === 'not_found') {
      await assert.rejects(
        operation,
        (error) => error instanceof AuthorizationDeniedError && error.conceal === true,
      );
    } else {
      await assert.rejects(
        operation,
        (error) => error instanceof TenantUserLifecycleConflictError
          && error.currentVersion === 4,
      );
    }
  }

  const selfHarness = service({
    async listByTenantId() {
      return [];
    },
    async changeAccess() {
      throw new Error('must not reach persistence');
    },
  });
  await assert.rejects(
    selfHarness.service.setAccess({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      targetUserId: ADMIN_ID,
      active: false,
      expectedVersion: 1,
      correlationId: CORRELATION_ID,
    }),
    (error) => error instanceof AuthorizationDeniedError
      && error.code === 'SELF_LIFECYCLE_CHANGE_NOT_AUTHORIZED',
  );

  const crossTenantHarness = service({
    async listByTenantId() {
      return [storedUser({ tenantId: OTHER_TENANT_ID })];
    },
    async changeAccess() {},
  });
  await assert.rejects(
    crossTenantHarness.service.listUsers({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    /TENANT_USER_LIFECYCLE_RESULT_INVALID/,
  );
});

test('Tenant User lifecycle reads and writes deny non-administrative principals before persistence', async () => {
  const harness = service({
    async listByTenantId() {
      throw new Error('must not reach persistence');
    },
    async changeAccess() {
      throw new Error('must not reach persistence');
    },
  });
  const employee = principal({
    roles: ['employee'],
    permissions: ['request:read', 'request:cancel'],
  });

  await assert.rejects(
    harness.service.listUsers({
      principal: employee,
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    harness.service.setAccess({
      principal: employee,
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      targetUserId: USER_ID,
      active: false,
      expectedVersion: 2,
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(harness.audit.events.length, 2);
  assert.equal(harness.audit.events.every((event) => event.action === 'authorization.denied'), true);
});

test('listing and mutation reject malformed bounds before persistence', async () => {
  const harness = service({
    async listByTenantId() {
      throw new Error('must not reach persistence');
    },
    async changeAccess() {
      throw new Error('must not reach persistence');
    },
  });
  for (const values of [
    { limit: 0 },
    { limit: 101 },
    { search: '' },
    { search: ' padded ' },
    { status: 'suspended' },
    { role: 'platform_admin' },
    { providerLink: 'provider-reference' },
  ]) {
    await assert.rejects(
      harness.service.listUsers({
        principal: principal(),
        tenantContext: { tenantId: TENANT_ID, status: 'active' },
        correlationId: CORRELATION_ID,
        ...values,
      }),
      AuthorizationInputError,
    );
  }
  await assert.rejects(
    harness.service.setAccess({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      targetUserId: USER_ID,
      active: true,
      expectedVersion: 0,
      correlationId: CORRELATION_ID,
    }),
    AuthorizationInputError,
  );
});
