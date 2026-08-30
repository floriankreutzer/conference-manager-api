import assert from 'node:assert/strict';
import test from 'node:test';
import { issuePlatformFallbackGrant } from '../src/platform/fallback/grant-fallback.js';
import { executePlatformRecoveryFallback } from '../src/platform/fallback/recovery-fallback.js';
import { PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';

const TOKEN_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const GRANT = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const TENANT = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const CORRELATION = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY = '44444444-4444-4444-8444-444444444444';
const CONTEXT = '55555555-5555-4555-8555-555555555555';

function recoveryRequest(overrides = {}) {
  return {
    version: 1,
    sessionToken: TOKEN_A,
    grantToken: GRANT,
    operation: 'last-tenant-admin',
    tenantId: TENANT,
    targetUserId: TARGET,
    reason: 'Restore verified tenant administration access',
    confirmation: { action: 'tenant.recovery.last_admin', tenantId: TENANT },
    correlationId: CORRELATION,
    idempotencyKey: IDEMPOTENCY,
    ...overrides,
  };
}

test('recovery fallback uses canonical preview and mutation inside grant consumption', async () => {
  const calls = [];
  const principal = { operatorId: 'operator' };
  const services = {
    sessionService: {
      async resolvePrincipal(request) {
        calls.push(['session', request.headers.cookie]);
        return principal;
      },
    },
    recoveryService: {
      async previewLastTenantAdmin(input) {
        calls.push(['preview', input]);
        return { recoveryContextId: CONTEXT };
      },
      async recoverLastTenantAdmin(input) {
        calls.push(['execute', input]);
        return { schemaVersion: 1, outcome: 'updated' };
      },
    },
    breakGlassService: {
      async execute(input) {
        calls.push(['grant', input.permission, input.targetTenantId]);
        return input.mutation({});
      },
    },
  };
  const result = await executePlatformRecoveryFallback({ request: recoveryRequest(), services });
  assert.deepEqual(result, { schemaVersion: 1, outcome: 'updated' });
  assert.equal(calls[0][1], `cm_platform_session=${TOKEN_A}`);
  assert.equal(calls[1][0], 'preview');
  assert.deepEqual(calls[2], ['grant', PLATFORM_PERMISSION.RECOVERY_EXECUTE, TENANT]);
  assert.equal(calls[3][1].recoveryContextId, CONTEXT);
});

test('recovery fallback rejects token, confirmation, target, and schema substitution before service access', async () => {
  const services = {};
  await assert.rejects(executePlatformRecoveryFallback({
    request: recoveryRequest({ confirmation: { action: 'tenant.recovery.suspend', tenantId: TENANT } }),
    services,
  }), /PLATFORM_FALLBACK_CONFIRMATION_INVALID/);
  await assert.rejects(executePlatformRecoveryFallback({
    request: recoveryRequest({ extra: true }),
    services,
  }), /PLATFORM_FALLBACK_INPUT_INVALID/);
  await assert.rejects(executePlatformRecoveryFallback({
    request: recoveryRequest({ targetUserId: 'not-an-id' }),
    services,
  }), /PLATFORM_FALLBACK_INPUT_INVALID/);
});

test('grant issuance resolves two live sessions and delegates dual-control persistence', async () => {
  const principals = [{ operatorId: 'one' }, { operatorId: 'two' }];
  const calls = [];
  const result = await issuePlatformFallbackGrant({
    request: {
      version: 1,
      principalSessionToken: TOKEN_A,
      approverSessionToken: TOKEN_B,
      targetTenantId: TENANT,
      permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
      reason: 'Approved incident recovery operation',
      approvalReference: 'INC-2026-0042',
      ttlSeconds: 300,
      correlationId: CORRELATION,
    },
    services: {
      sessionService: {
        async resolvePrincipal() { return principals.shift(); },
      },
      breakGlassService: {
        async issue(input) { calls.push(input); return { token: GRANT, grant: { id: CONTEXT } }; },
      },
    },
  });
  assert.equal(result.token, GRANT);
  assert.equal(calls[0].principal.operatorId, 'one');
  assert.equal(calls[0].approverPrincipal.operatorId, 'two');
});
