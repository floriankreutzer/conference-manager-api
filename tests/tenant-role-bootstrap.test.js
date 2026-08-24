import assert from 'node:assert/strict';
import test from 'node:test';
import { createJitUserService } from '../src/identity/jit-user-service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_REFERENCE = '44444444-4444-4444-8444-444444444444';
const USER_REFERENCE = '55555555-5555-4555-8555-555555555555';

function external(userReference = USER_REFERENCE) {
  return {
    provider: 'microsoft_entra',
    tenantReference: TENANT_REFERENCE,
    userReference,
    displayName: 'Customer Admin',
  };
}

function auditService() {
  return {
    createActorEvent(value) {
      return Object.freeze({ ...value });
    },
  };
}

test('validated onboarding claimant bootstraps the first Tenant Admin through JIT', async () => {
  let provisionInput;
  const service = createJitUserService({
    bindingRepository: {
      async findActiveBindingByProvider() {
        return {
          tenantId: TENANT_ID,
          claimantProviderUserReference: USER_REFERENCE,
        };
      },
    },
    userRepository: {
      async resolveOrProvision(value) {
        provisionInput = value;
        return {
          status: 'resolved',
          identity: {
            tenantId: TENANT_ID,
            userId: USER_ID,
            displayName: 'Customer Admin',
            active: true,
            securityVersion: 1,
            elevatedRoles: ['tenant_admin'],
          },
        };
      },
    },
    auditService: auditService(),
    clock: () => Date.parse('2026-08-24T16:00:00.000Z'),
    idFactory: () => USER_ID,
  });

  const result = await service.resolve(external(), { correlationId: CORRELATION_ID });
  assert.equal(provisionInput.bootstrapTenantAdmin, true);
  assert.equal(provisionInput.bootstrapAuditEvent.action, 'tenant.user_permissions.changed');
  assert.equal(provisionInput.bootstrapAuditEvent.metadata.source, 'tenant_claimant');
  assert.deepEqual(result.trustedIdentity.roles, ['employee', 'tenant_admin']);
  assert.deepEqual(result.trustedIdentity.permissions, [
    'request:read',
    'request:cancel',
    'tenant:configure',
    'tenant:users:manage',
    'tenant:integrations:manage',
    'tenant:audit:read',
  ]);
});

test('non-claimant cannot request bootstrap and persisted roles remain server-authoritative', async () => {
  let provisionInput;
  const otherUserReference = '66666666-6666-4666-8666-666666666666';
  const service = createJitUserService({
    bindingRepository: {
      async findActiveBindingByProvider() {
        return {
          tenantId: TENANT_ID,
          claimantProviderUserReference: USER_REFERENCE,
        };
      },
    },
    userRepository: {
      async resolveOrProvision(value) {
        provisionInput = value;
        return {
          status: 'resolved',
          identity: {
            tenantId: TENANT_ID,
            userId: USER_ID,
            displayName: 'Conference Manager',
            active: true,
            securityVersion: 2,
            elevatedRoles: ['conference_manager'],
          },
        };
      },
    },
    auditService: auditService(),
    clock: () => Date.parse('2026-08-24T16:00:00.000Z'),
    idFactory: () => USER_ID,
  });

  const result = await service.resolve(external(otherUserReference), { correlationId: CORRELATION_ID });
  assert.equal(provisionInput.bootstrapTenantAdmin, false);
  assert.equal(provisionInput.bootstrapAuditEvent, null);
  assert.deepEqual(result.trustedIdentity.roles, ['employee', 'conference_manager']);
  assert.deepEqual(result.trustedIdentity.permissions, [
    'request:read',
    'request:cancel',
    'request:manage',
  ]);
});
