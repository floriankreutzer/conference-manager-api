import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { PLATFORM_AUDIT_ACTION, PLATFORM_AUDIT_OUTCOME } from '../src/platform/audit/event.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import { createPlatformOperationAuthorizer } from '../src/platform/identity/operation-authorization.js';
import { PLATFORM_PERMISSION, PLATFORM_ROLE, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';

function principal() {
  const roles = [PLATFORM_ROLE.SUPPORT_READER];
  return {
    operatorId: OPERATOR_ID,
    providerIdentity: {
      provider: 'microsoft_entra_platform',
      tenantReference: 'operator-tenant',
      subjectReference: 'operator-subject',
    },
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion: 1,
    targetScope: { mode: 'allowlist', securityVersion: 1 },
    assurance: {
      level: 'mfa',
      authenticationContext: 'cm-platform-mfa',
      authenticatedAt: '2026-08-28T11:59:00.000Z',
    },
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z',
      securityVersion: 1,
      securityEpoch: 7,
      stepUpExpiresAt: null,
    },
  };
}

function harness({ permissionDecision, targetDecision }) {
  const events = [];
  const auditService = createPlatformAuditService({
    repository: {
      async append(event, options) { events.push({ event, options }); return event; },
      async listVerified() { return []; },
    },
    authorizationPolicy: { authorize() { return true; } },
    tenantTargetPolicy: { async queryScope() { return {}; } },
    clock: () => Date.parse('2026-08-28T12:01:00.000Z'),
  });
  const authorizer = createPlatformOperationAuthorizer({
    authorizationPolicy: { async authorize() { return permissionDecision(); } },
    tenantTargetPolicy: { async authorize() { return targetDecision(); } },
    auditService,
  });
  return { authorizer, events };
}

test('permission and target denials persist actor-attributed non-enumerating audit evidence', async () => {
  for (const deniedAt of ['permission', 'target']) {
    const state = harness({
      permissionDecision: () => {
        if (deniedAt === 'permission') throw new PlatformAuthorizationError('SPECIFIC_PERMISSION_DENIAL');
        return true;
      },
      targetDecision: () => {
        throw new PlatformAuthorizationError('SPECIFIC_TARGET_DENIAL');
      },
    });
    await assert.rejects(state.authorizer.authorize({
      principal: principal(),
      permission: PLATFORM_PERMISSION.TENANT_READ,
      targetTenantId: TENANT_ID,
      operation: 'tenant.directory.read',
      correlationId: CORRELATION_ID,
    }), (error) => error.code === 'PLATFORM_AUTHORIZATION_DENIED');
    assert.equal(state.events.length, 1);
    const [{ event, options }] = state.events;
    assert.equal(event.operatorId, OPERATOR_ID);
    assert.equal(event.targetTenantId, TENANT_ID);
    assert.equal(event.action, PLATFORM_AUDIT_ACTION.AUTHORIZATION_DENIED);
    assert.equal(event.outcome, PLATFORM_AUDIT_OUTCOME.DENIED);
    assert.equal(event.metadata.reasonCode, `${deniedAt}_denied`);
    assert.deepEqual(options, { expectedTargetTenantId: TENANT_ID });
  }
});

test('unexpected authorization dependency failures are not mislabeled as denials', async () => {
  const state = harness({
    permissionDecision: () => { throw new Error('DEPENDENCY_UNAVAILABLE'); },
    targetDecision: () => true,
  });
  await assert.rejects(state.authorizer.authorize({
    principal: principal(),
    permission: PLATFORM_PERMISSION.TENANT_READ,
    targetTenantId: TENANT_ID,
    operation: 'tenant.directory.read',
    correlationId: CORRELATION_ID,
  }), /DEPENDENCY_UNAVAILABLE/);
  assert.equal(state.events.length, 0);
});
