import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizePlatformOperation,
  PLATFORM_OPERATION,
  platformPermissionForOperation,
} from '../src/platform/application/platform-operation-contract.js';
import { PlatformOperationDeniedError } from '../src/platform/application/platform-operation-errors.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import { isKnownPlatformPermission, PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';

test('every Platform operation resolves to the canonical approved permission identifier', () => {
  const expected = new Map([
    [PLATFORM_OPERATION.TENANT_DIRECTORY_READ, PLATFORM_PERMISSION.TENANT_READ],
    [PLATFORM_OPERATION.TENANT_INVITATION_CREATE, PLATFORM_PERMISSION.INVITATION_MANAGE],
    [PLATFORM_OPERATION.INVITATION_REVOKE, PLATFORM_PERMISSION.INVITATION_MANAGE],
    [PLATFORM_OPERATION.INVITATION_REISSUE, PLATFORM_PERMISSION.INVITATION_MANAGE],
    [PLATFORM_OPERATION.LIFECYCLE_TRANSITION, PLATFORM_PERMISSION.LIFECYCLE_MANAGE],
    [PLATFORM_OPERATION.ENTITLEMENT_READ, PLATFORM_PERMISSION.ENTITLEMENT_READ],
    [PLATFORM_OPERATION.ENTITLEMENT_APPLY, PLATFORM_PERMISSION.ENTITLEMENT_MANAGE],
    [PLATFORM_OPERATION.READINESS_READ, PLATFORM_PERMISSION.READINESS_READ],
    [PLATFORM_OPERATION.MICROSOFT_HEALTH_READ, PLATFORM_PERMISSION.INTEGRATION_HEALTH_READ],
    [PLATFORM_OPERATION.DIAGNOSTIC_SUMMARY_READ, PLATFORM_PERMISSION.DIAGNOSTICS_READ],
    [PLATFORM_OPERATION.DIAGNOSTIC_CORRELATION_READ, PLATFORM_PERMISSION.DIAGNOSTICS_SENSITIVE],
    [PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
    [PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
    [PLATFORM_OPERATION.REPAIR_ROOM_MAPPING, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
    [PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
    [PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS, PLATFORM_PERMISSION.SESSION_REVOKE],
    [PLATFORM_OPERATION.REVOKE_USER_SESSIONS, PLATFORM_PERMISSION.SESSION_REVOKE],
    [PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
    [PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
  ]);
  assert.equal(expected.size, Object.values(PLATFORM_OPERATION).length);
  for (const operation of Object.values(PLATFORM_OPERATION)) {
    const permission = platformPermissionForOperation(operation);
    assert.equal(permission, expected.get(operation));
    assert.equal(isKnownPlatformPermission(permission), true);
  }
});

test('the application adapter translates canonical authorization failures to safe operation denials', async () => {
  const policy = {
    authorize() {
      throw new PlatformAuthorizationError('PLATFORM_STEP_UP_REQUIRED');
    },
  };
  await assert.rejects(
    authorizePlatformOperation({
      authorizationPolicy: policy,
      tenantTargetPolicy: { async authorize() { return true; } },
      operatorContext: { source: 'trusted_session' },
      operation: PLATFORM_OPERATION.INVITATION_REISSUE,
      tenantId: '11111111-1111-4111-8111-111111111111',
    }),
    (error) => error instanceof PlatformOperationDeniedError && error.code === 'PLATFORM_STEP_UP_REQUIRED',
  );
});

test('unknown operations and non-policy failures are not silently converted to authorization outcomes', async () => {
  assert.throws(() => platformPermissionForOperation('platform.command'), /PLATFORM_OPERATION_UNKNOWN/);
  const failure = new Error('POLICY_CONFIGURATION_BROKEN');
  await assert.rejects(
    authorizePlatformOperation({
      authorizationPolicy: { authorize() { throw failure; } },
      tenantTargetPolicy: { async queryScope() { return { mode: 'all' }; } },
      operatorContext: { source: 'trusted_session' },
      operation: PLATFORM_OPERATION.TENANT_DIRECTORY_READ,
      fleet: true,
    }),
    (error) => error === failure,
  );
});

test('permission success never bypasses server-owned Tenant target denial', async () => {
  const allowedTenantId = '11111111-1111-4111-8111-111111111111';
  const deniedTenantId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const policy = { authorize() { return true; } };
  const tenantTargetPolicy = {
    async authorize(_principal, tenantId) {
      calls.push(tenantId);
      await Promise.resolve();
      if (tenantId !== allowedTenantId) throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
      return true;
    },
  };
  const [allowed, denied] = await Promise.allSettled([
    authorizePlatformOperation({
      authorizationPolicy: policy,
      tenantTargetPolicy,
      operatorContext: {},
      operation: PLATFORM_OPERATION.LIFECYCLE_TRANSITION,
      tenantId: allowedTenantId,
    }),
    authorizePlatformOperation({
      authorizationPolicy: policy,
      tenantTargetPolicy,
      operatorContext: {},
      operation: PLATFORM_OPERATION.LIFECYCLE_TRANSITION,
      tenantId: deniedTenantId,
    }),
  ]);
  assert.equal(allowed.status, 'fulfilled');
  assert.equal(allowed.value.targetTenantId, allowedTenantId);
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.reason.code, 'PLATFORM_TENANT_TARGET_DENIED');
  assert.deepEqual(calls.sort(), [allowedTenantId, deniedTenantId].sort());
});

test('fleet authorization yields an immutable server-owned query scope for repository enforcement', async () => {
  const sourceScope = { mode: 'allowlist', securityVersion: 4, scopeKey: 'operator-scope-4' };
  const authorization = await authorizePlatformOperation({
    authorizationPolicy: { authorize() { return true; } },
    tenantTargetPolicy: { async queryScope() { return sourceScope; } },
    operatorContext: {},
    operation: PLATFORM_OPERATION.TENANT_DIRECTORY_READ,
    fleet: true,
  });
  assert.deepEqual(authorization.targetAuthorization, sourceScope);
  assert.equal(Object.isFrozen(authorization.targetAuthorization), true);
  sourceScope.mode = 'all';
  assert.equal(authorization.targetAuthorization.mode, 'allowlist');
});
