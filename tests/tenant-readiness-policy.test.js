import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTenantReadinessCheck,
  createTenantReadinessPolicy,
  evaluateTenantReadinessSnapshot,
  TENANT_READINESS_CHECK,
} from '../src/tenancy/tenant-readiness-policy.js';

const AS_OF = Date.parse('2026-08-28T12:00:00.000Z');
const FRESH_OBSERVATION = '2026-08-28T11:50:00.000Z';
const STALE_OBSERVATION = '2026-08-28T11:00:00.000Z';

test('canonical Tenant readiness policy owns check contracts and produces a ready snapshot', () => {
  const policy = createTenantReadinessPolicy();
  const checkIds = policy.requiredCheckIds({ lifecycleStatus: 'active' });
  const checks = checkIds.map((checkId) => createTenantReadinessCheck({
    checkId,
    passed: true,
    observedAt: FRESH_OBSERVATION,
  }));

  const result = policy.evaluateSnapshot({ checks, lifecycleStatus: 'active', asOfMs: AS_OF });

  assert.equal(result.state, 'ready');
  assert.deepEqual(result.blockerCodes, []);
  assert.equal(result.checks.length, checkIds.length);
  assert.deepEqual(checks[0], {
    checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
    category: 'identity',
    state: 'pass',
    reasonCode: null,
    observedAt: FRESH_OBSERVATION,
    freshUntil: '2026-08-28T12:05:00.000Z',
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
});

test('canonical evaluation preserves failure precedence and reports stale and missing blockers', () => {
  const failed = createTenantReadinessCheck({
    checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
    passed: false,
    observedAt: STALE_OBSERVATION,
  });
  const result = evaluateTenantReadinessSnapshot({
    checks: [failed],
    requiredCheckIds: [
      TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
      TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY,
    ],
    asOfMs: AS_OF,
  });

  assert.equal(result.state, 'blocked');
  assert.deepEqual(result.blockerCodes, [
    'microsoft.free_busy.healthy.unknown',
    'tenant.identity.active.stale',
    'tenant.identity.inactive',
  ]);
  assert.equal(result.checks[0].freshness, 'stale');
});

test('Tenant readiness policy rejects malformed, duplicate, and ambiguous authority data', () => {
  assert.throws(
    () => createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
      passed: 'yes',
      observedAt: FRESH_OBSERVATION,
    }),
    /TENANT_READINESS_CHECK_INVALID/,
  );
  assert.throws(
    () => createTenantReadinessCheck({
      checkId: 'tenant.identity.unknown',
      passed: true,
      observedAt: FRESH_OBSERVATION,
    }),
    /TENANT_READINESS_CHECK_ID_INVALID/,
  );
  assert.throws(
    () => createTenantReadinessCheck({
      checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
      passed: true,
      observedAt: 'not-a-timestamp',
    }),
    /TENANT_READINESS_CHECK_INVALID/,
  );

  const check = createTenantReadinessCheck({
    checkId: TENANT_READINESS_CHECK.IDENTITY_ACTIVE,
    passed: true,
    observedAt: FRESH_OBSERVATION,
  });
  assert.throws(
    () => evaluateTenantReadinessSnapshot({
      checks: [{ ...check, category: 'entitlement' }],
      requiredCheckIds: [TENANT_READINESS_CHECK.IDENTITY_ACTIVE],
      asOfMs: AS_OF,
    }),
    /TENANT_READINESS_CHECK_INVALID/,
  );
  assert.throws(
    () => evaluateTenantReadinessSnapshot({
      checks: [check, check],
      requiredCheckIds: [TENANT_READINESS_CHECK.IDENTITY_ACTIVE],
      asOfMs: AS_OF,
    }),
    /TENANT_READINESS_CHECK_INVALID/,
  );
  assert.throws(
    () => createTenantReadinessPolicy().evaluateSnapshot({
      checks: [check],
      lifecycleStatus: 'deleted',
      asOfMs: AS_OF,
    }),
    /TENANT_READINESS_LIFECYCLE_INVALID/,
  );
});
