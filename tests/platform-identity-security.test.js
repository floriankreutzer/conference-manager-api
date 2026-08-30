import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformClaimPolicy } from '../src/platform/identity/claim-policy.js';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';
import { createPlatformIdentityService } from '../src/platform/identity/identity-service.js';
import {
  PLATFORM_PERMISSION,
  PLATFORM_ROLE,
  createPlatformAuthorizationPolicy,
  permissionsForPlatformRoles,
} from '../src/platform/identity/policy.js';
import {
  normalizePlatformPrincipal,
  normalizeTrustedPlatformIdentity,
} from '../src/platform/identity/principal.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-08-28T12:00:00.000Z');

function identity(overrides = {}) {
  const roles = overrides.roles || [PLATFORM_ROLE.SUPPORT_READER];
  return {
    operatorId: OPERATOR_ID,
    providerIdentity: {
      provider: 'entra_platform',
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
      authenticatedAt: '2026-08-28T11:55:00.000Z',
    },
    ...overrides,
  };
}

function principal(overrides = {}) {
  return {
    ...identity(overrides),
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-28T11:55:00.000Z',
      expiresAt: '2026-08-28T15:55:00.000Z',
      securityVersion: 1,
      securityEpoch: 7,
      stepUpExpiresAt: null,
    },
  };
}

function claimPolicy() {
  return createPlatformClaimPolicy({
    provider: 'entra_platform',
    issuer: 'https://login.example/operator/v2.0',
    audience: 'platform-client',
    tenantReference: 'operator-tenant',
    mfaAuthenticationContext: 'cm-platform-mfa',
    stepUpAuthenticationContext: 'cm-platform-step-up',
  });
}

function verifiedClaims(overrides = {}) {
  return {
    verified: true,
    claims: {
      provider: 'entra_platform',
      issuer: 'https://login.example/operator/v2.0',
      audience: 'platform-client',
      tenantReference: 'operator-tenant',
      subjectReference: 'operator-subject',
      authenticationContext: 'cm-platform-mfa',
      authenticatedAt: '2026-08-28T11:55:00.000Z',
      ...overrides,
    },
  };
}

test('canonical Platform roles derive the exact accepted ADR permission matrix', () => {
  assert.deepEqual(permissionsForPlatformRoles([PLATFORM_ROLE.SUPPORT_READER]), [
    'platform:diagnostics:read',
    'platform:entitlement:read',
    'platform:integration-health:read',
    'platform:metering:read',
    'platform:readiness:read',
    'platform:runtime:read',
    'platform:tenant:read',
  ]);
  assert.ok(permissionsForPlatformRoles([PLATFORM_ROLE.TENANT_OPERATOR]).includes('platform:invitation:manage'));
  assert.throws(() => permissionsForPlatformRoles(['platform_admin']), /PLATFORM_ROLES_INVALID/);
  assert.throws(() => permissionsForPlatformRoles(['tenant_admin']), /PLATFORM_ROLES_INVALID/);
});

test('Platform identity and principal reject customer and unknown authority-shaped fields', () => {
  assert.throws(() => normalizeTrustedPlatformIdentity({ ...identity(), tenantId: OPERATOR_ID }), {
    message: 'PLATFORM_IDENTITY_FIELDS_INVALID',
  });
  assert.throws(() => normalizeTrustedPlatformIdentity({ ...identity(), userId: OPERATOR_ID }), {
    message: 'PLATFORM_IDENTITY_FIELDS_INVALID',
  });
  assert.throws(() => normalizeTrustedPlatformIdentity(identity({ roles: ['tenant_admin'] })));
  assert.throws(() => normalizeTrustedPlatformIdentity({ ...identity(), permissions: ['platform:tenant:read'] }));
  assert.throws(() => normalizePlatformPrincipal({ ...principal(), customerRole: 'tenant_admin' }), {
    message: 'PLATFORM_PRINCIPAL_FIELDS_INVALID',
  });
  assert.throws(() => normalizePlatformPrincipal({
    ...principal(),
    assurance: { ...principal().assurance, amr: ['mfa'] },
  }), { message: 'PLATFORM_ASSURANCE_INVALID' });
  assert.throws(() => normalizePlatformPrincipal({
    ...principal(),
    session: { ...principal().session, tenantId: OPERATOR_ID },
  }), { message: 'PLATFORM_SESSION_METADATA_INVALID' });
  assert.throws(() => normalizePlatformPrincipal({
    ...principal(),
    assurance: { ...principal().assurance, authenticatedAt: '2026-08-28T11:55:00Z' },
  }), { message: 'PLATFORM_ASSURANCE_INVALID' });
});

test('verified claim boundary rejects customer authority, wrong issuer/audience/Tenant, and unknown context', () => {
  const policy = claimPolicy();
  assert.equal(policy.normalize(verifiedClaims()).assurance.level, 'mfa');
  for (const claims of [
    verifiedClaims({ issuer: 'https://login.example/customer/v2.0' }),
    verifiedClaims({ audience: 'customer-client' }),
    verifiedClaims({ tenantReference: 'customer-tenant' }),
    verifiedClaims({ authenticationContext: 'password-only' }),
    verifiedClaims({ authenticatedAt: '2026-08-28T11:55:00Z' }),
    verifiedClaims({ roles: ['platform_security_admin'] }),
    verifiedClaims({ groups: ['operators'] }),
    verifiedClaims({ customerTenantId: OPERATOR_ID }),
    verifiedClaims({ targetScope: { mode: 'all' } }),
  ]) assert.throws(() => policy.normalize(claims), PlatformIdentityError);
  assert.throws(() => policy.normalize({ verified: false, claims: verifiedClaims().claims }), PlatformIdentityError);
});

test('identity mapping grants only locally provisioned canonical roles', async () => {
  let verifierResult = verifiedClaims();
  const failureEvents = [];
  const repository = {
    async findActiveByProviderIdentity() {
      return {
        id: OPERATOR_ID,
        roles: [PLATFORM_ROLE.SECURITY_AUDITOR],
        securityVersion: 4,
        scopeMode: 'all',
      };
    },
  };
  const service = createPlatformIdentityService({
    claimVerifier: { async verify() { return verifierResult; } },
    claimPolicy: claimPolicy(),
    operatorRepository: repository,
    auditService: {
      createUnmappedAuthenticationFailure(values) { return values; },
      async record(value) { failureEvents.push(value); },
    },
  });
  const resolved = await service.verify('opaque-verified-assertion');
  assert.deepEqual(resolved.roles, [PLATFORM_ROLE.SECURITY_AUDITOR]);
  assert.ok(resolved.permissions.includes(PLATFORM_PERMISSION.AUDIT_READ));
  assert.equal(resolved.securityVersion, 4);
  assert.deepEqual(resolved.targetScope, { mode: 'all', securityVersion: 4 });

  repository.findActiveByProviderIdentity = async () => null;
  await assert.rejects(service.verify('unknown'), PlatformIdentityError);
  verifierResult = verifiedClaims({ roles: ['platform_security_admin'] });
  await assert.rejects(service.verify('forged-role'), PlatformIdentityError);
  assert.deepEqual(failureEvents.map((entry) => entry.reasonCode), [
    'operator_not_provisioned',
    'claims_fields_invalid',
  ]);
});

test('Platform authorization requires MFA and fresh step-up for privileged permissions', () => {
  const policy = createPlatformAuthorizationPolicy({ clock: () => NOW });
  const reader = normalizePlatformPrincipal(principal());
  assert.equal(policy.authorize(reader, PLATFORM_PERMISSION.TENANT_READ), true);
  assert.throws(() => policy.authorize(reader, PLATFORM_PERMISSION.RECOVERY_EXECUTE));

  const roles = [PLATFORM_ROLE.SECURITY_ADMIN];
  const elevated = normalizePlatformPrincipal({
    ...principal({
      roles,
      permissions: permissionsForPlatformRoles(roles),
      assurance: {
        level: 'step_up',
        authenticationContext: 'cm-platform-step-up',
        authenticatedAt: '2026-08-28T11:58:00.000Z',
      },
    }),
    session: {
      ...principal().session,
      issuedAt: '2026-08-28T12:00:00.000Z',
      stepUpExpiresAt: '2026-08-28T12:03:00.000Z',
    },
  });
  assert.equal(policy.authorize(elevated, PLATFORM_PERMISSION.RECOVERY_EXECUTE), true);
  assert.throws(() => policy.authorize({ ...elevated, permissions: [] }, PLATFORM_PERMISSION.TENANT_READ));
});

test('Tenant target policy checks the current server allowlist and stale security version', async () => {
  const allowedTenantId = '33333333-3333-4333-8333-333333333333';
  const otherTenantId = '44444444-4444-4444-8444-444444444444';
  const calls = [];
  let fleetMode = false;
  let active = true;
  const policy = createPlatformTenantTargetPolicy({
    operatorRepository: {
      async isTenantAllowed(input) {
        calls.push(input);
        return active
          && input.securityVersion === 1
          && (fleetMode || input.tenantId === allowedTenantId);
      },
      async loadTargetScope(input) {
        return {
          mode: fleetMode ? 'all' : 'allowlist',
          operatorId: input.operatorId,
          securityVersion: input.securityVersion,
        };
      },
    },
  });
  const scoped = normalizePlatformPrincipal(principal());
  assert.equal(await policy.authorize(scoped, allowedTenantId), true);
  await assert.rejects(policy.authorize(scoped, otherTenantId), /PLATFORM_TENANT_TARGET_DENIED/);
  await assert.rejects(policy.authorize(scoped, 'browser-selected-tenant'), /PLATFORM_TENANT_TARGET_DENIED/);
  assert.equal(calls.length, 2);
  assert.deepEqual(await policy.queryScope(scoped), {
    mode: 'allowlist',
    operatorId: OPERATOR_ID,
    securityVersion: 1,
  });
  await assert.rejects(policy.authorizeCreation(scoped), /PLATFORM_TENANT_CREATION_DENIED/);

  const fleet = normalizePlatformPrincipal({
    ...principal(),
    targetScope: { mode: 'all', securityVersion: 1 },
  });
  fleetMode = true;
  assert.equal(await policy.authorize(fleet, otherTenantId), true);
  assert.equal(await policy.authorizeCreation(fleet), true);
  assert.equal(calls.length, 3);
  active = false;
  await assert.rejects(policy.authorize(fleet, otherTenantId), /PLATFORM_TENANT_TARGET_DENIED/);
  assert.throws(() => normalizePlatformPrincipal({
    ...principal(),
    targetScope: { mode: 'all', securityVersion: 2 },
  }), /PLATFORM_TARGET_SCOPE_INVALID/);
});
