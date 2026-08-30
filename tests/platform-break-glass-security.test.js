import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlatformBreakGlassGrant,
  createPlatformBreakGlassAuthorizationContext,
  hashPlatformBreakGlassToken,
  normalizePlatformBreakGlassConsumption,
} from '../src/platform/identity/break-glass.js';
import { PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const APPROVER_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function grant(overrides = {}) {
  return createPlatformBreakGlassGrant({
    operatorId: OPERATOR_ID,
    operatorSecurityVersion: 3,
    approverOperatorId: APPROVER_ID,
    approverSecurityVersion: 5,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    reason: 'Restore authoritative tenant administration access',
    approvalReference: 'INC-2026-0042',
    ttlSeconds: 600,
    idFactory: () => GRANT_ID,
    tokenFactory: () => TOKEN,
    ...overrides,
  });
}

test('break-glass grant is opaque, dual-controlled, Tenant/action-bound, and short-lived', () => {
  const created = grant();
  assert.equal(created.token, TOKEN);
  assert.equal(created.record.tokenHash, hashPlatformBreakGlassToken(TOKEN));
  assert.doesNotMatch(JSON.stringify(created.record), new RegExp(TOKEN));
  assert.throws(() => grant({ approverOperatorId: OPERATOR_ID }));
  assert.throws(() => grant({ permission: PLATFORM_PERMISSION.OPERATOR_MANAGE }));
  assert.throws(() => grant({ ttlSeconds: 1_801 }));
  assert.throws(() => grant({ reason: 'too short' }));
});

test('consumed grant becomes a narrow authorization context, never a normal Platform principal', () => {
  const context = createPlatformBreakGlassAuthorizationContext({
    id: GRANT_ID,
    operatorId: OPERATOR_ID,
    approverOperatorId: APPROVER_ID,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    reason: 'Restore authoritative tenant administration access',
    approvalReference: 'INC-2026-0042',
    issuedAt: '2026-08-28T12:00:00.000Z',
    expiresAt: '2026-08-28T12:10:00.000Z',
    consumedAt: '2026-08-28T12:01:00.000Z',
  });
  assert.deepEqual(context, {
    kind: 'platform_break_glass',
    grantId: GRANT_ID,
    operatorId: OPERATOR_ID,
    approverOperatorId: APPROVER_ID,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    approvalReference: 'INC-2026-0042',
    expiresAt: '2026-08-28T12:10:00.000Z',
  });
  assert.equal(context.roles, undefined);
  assert.throws(() => createPlatformBreakGlassAuthorizationContext({
    ...context,
    targetTenantId: '55555555-5555-4555-8555-555555555555',
  }));
});

test('break-glass consumption requires the exact opaque token, operator, Tenant, and permission', () => {
  const consumption = normalizePlatformBreakGlassConsumption({
    token: TOKEN,
    operatorId: OPERATOR_ID,
    operatorSecurityVersion: 3,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
  });
  assert.equal(consumption.operatorId, OPERATOR_ID);
  assert.equal(consumption.targetTenantId, TENANT_ID);
  assert.notEqual(consumption.tokenHash, TOKEN);
  assert.throws(() => normalizePlatformBreakGlassConsumption({
    token: TOKEN,
    operatorId: OPERATOR_ID,
    operatorSecurityVersion: 3,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.OPERATOR_MANAGE,
  }));
});
