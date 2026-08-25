import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY,
  ROLLOUT_STATE,
  evaluateEffectiveCapability,
  normalizeCapabilityId,
} from '../src/entitlements/capabilities.js';
import { EntitlementDeniedError, EntitlementInputError } from '../src/entitlements/errors.js';
import { createEntitlementService } from '../src/entitlements/entitlement-service.js';

const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const USER_A = '11111111-1111-4111-8111-111111111111';
const CORRELATION = '44444444-4444-4444-8444-444444444444';

function principal(tenantId = TENANT_A) {
  return { userId: USER_A, tenantId };
}

function tenantContext(tenantId = TENANT_A, status = 'active') {
  return { tenantId, status };
}

function harness({ authorizedOperator = false } = {}) {
  const records = new Map();
  const auditEvents = [];
  let findCalls = 0;
  const rollout = new Map();
  const knownTenants = new Set([TENANT_A, TENANT_B]);
  const repository = {
    async findByTenantIdAndCapabilityId(tenantId, capabilityId) {
      findCalls += 1;
      return records.get(`${tenantId}:${capabilityId}`) || null;
    },
    async changeByTenantIdAndCapabilityId({ tenantId, capabilityId, enabled, changedAt, auditEventForPrevious }) {
      if (!knownTenants.has(tenantId)) return null;
      const key = `${tenantId}:${capabilityId}`;
      const existing = records.get(key) || null;
      const previousEnabled = existing?.enabled === true;
      if (!existing && enabled === false) {
        return Object.freeze({ tenantId, capabilityId, enabled: false, updatedAt: null });
      }
      if (existing?.enabled === enabled) return existing;
      const record = Object.freeze({ tenantId, capabilityId, enabled, updatedAt: changedAt.toISOString() });
      records.set(key, record);
      auditEvents.push(auditEventForPrevious(previousEnabled));
      return record;
    },
  };
  const auditService = {
    createActorEvent(values) {
      return Object.freeze({ ...values });
    },
  };
  const service = createEntitlementService({
    repository,
    auditService,
    authorizeOperator: async () => authorizedOperator,
    rolloutPolicy: {
      stateFor(capabilityId) {
        return rollout.get(capabilityId) ?? ROLLOUT_STATE.NOT_CONTROLLED;
      },
    },
    clock: () => Date.parse('2026-08-24T09:30:00.000Z'),
  });
  return {
    service,
    records,
    rollout,
    auditEvents,
    findCalls: () => findCalls,
  };
}

test('stable capability IDs and effective access fail closed', () => {
  assert.equal(normalizeCapabilityId(CAPABILITY.MICROSOFT_DIRECTORY), 'microsoft.directory');
  assert.equal(normalizeCapabilityId(CAPABILITY.MICROSOFT_CALENDAR), 'microsoft.calendar');
  assert.equal(normalizeCapabilityId(CAPABILITY.MICROSOFT_CALENDAR_WRITE), 'microsoft.calendar.write');
  assert.throws(() => normalizeCapabilityId('microsoft.unknown'), EntitlementInputError);

  for (const [authorized, entitled, rolloutState, expected] of [
    [false, true, ROLLOUT_STATE.ENABLED, false],
    [true, false, ROLLOUT_STATE.ENABLED, false],
    [true, true, ROLLOUT_STATE.DISABLED, false],
    [true, true, ROLLOUT_STATE.ENABLED, true],
    [true, true, ROLLOUT_STATE.NOT_CONTROLLED, true],
  ]) {
    assert.equal(evaluateEffectiveCapability({ authorized, entitled, rolloutState }), expected);
  }
});

test('calendar write entitlement remains independent from read/free-busy entitlement', async () => {
  const state = harness({ authorizedOperator: true });
  await state.service.setEntitlement({
    operatorContext: { kind: 'trusted' },
    tenantId: TENANT_A,
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
    enabled: true,
    correlationId: CORRELATION,
  });
  assert.equal(await state.service.evaluateAccess({
    principal: principal(),
    tenantContext: tenantContext(),
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
    authorized: true,
  }), true);
  assert.equal(await state.service.evaluateAccess({
    principal: principal(),
    tenantContext: tenantContext(),
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
    authorized: true,
  }), false);

  await state.service.setEntitlement({
    operatorContext: { kind: 'trusted' },
    tenantId: TENANT_A,
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
    enabled: true,
    correlationId: CORRELATION,
  });
  assert.equal(await state.service.evaluateAccess({
    principal: principal(),
    tenantContext: tenantContext(),
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
    authorized: true,
  }), true);
});

test('entitlement evaluation requires authorization, active tenant binding, entitlement, and rollout state', async () => {
  const state = harness({ authorizedOperator: true });
  await state.service.setEntitlement({
    operatorContext: { kind: 'test-operator' },
    tenantId: TENANT_A,
    capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
    enabled: true,
    correlationId: CORRELATION,
  });

  assert.equal(await state.service.evaluateAccess({
    principal: principal(),
    tenantContext: tenantContext(),
    capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
    authorized: true,
  }), true);

  state.rollout.set(CAPABILITY.MICROSOFT_DIRECTORY, ROLLOUT_STATE.DISABLED);
  assert.equal(await state.service.evaluateAccess({
    principal: principal(),
    tenantContext: tenantContext(),
    capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
    authorized: true,
  }), false);

  state.rollout.set(CAPABILITY.MICROSOFT_DIRECTORY, ROLLOUT_STATE.ENABLED);
  assert.equal(await state.service.evaluateAccess({
    principal: principal(),
    tenantContext: tenantContext(),
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
    authorized: true,
  }), false);

  const before = state.findCalls();
  for (const values of [
    { principal: principal(), tenantContext: tenantContext(), capabilityId: 'unknown.capability', authorized: true },
    { principal: principal(), tenantContext: tenantContext(), capabilityId: CAPABILITY.MICROSOFT_DIRECTORY, authorized: false },
    {
      principal: principal(TENANT_A),
      tenantContext: tenantContext(TENANT_B),
      capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
      authorized: true,
    },
    {
      principal: principal(),
      tenantContext: tenantContext(TENANT_A, 'suspended'),
      capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
      authorized: true,
    },
  ]) {
    assert.equal(await state.service.evaluateAccess(values), false);
  }
  assert.equal(state.findCalls(), before);
});

test('operator entitlement changes are deny-by-default, tenant-scoped, idempotent, and audited', async () => {
  const denied = harness();
  await assert.rejects(
    denied.service.setEntitlement({
      operatorContext: { kind: 'untrusted' },
      tenantId: TENANT_A,
      capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
      enabled: true,
      correlationId: CORRELATION,
    }),
    (error) => error instanceof EntitlementDeniedError && error.code === 'OPERATOR_NOT_AUTHORIZED',
  );
  assert.equal(denied.records.size, 0);
  assert.equal(denied.auditEvents.length, 0);

  const state = harness({ authorizedOperator: true });
  const enabled = await state.service.setEntitlement({
    operatorContext: { kind: 'trusted' },
    tenantId: TENANT_A,
    capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
    enabled: true,
    correlationId: CORRELATION,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(state.auditEvents.length, 1);
  assert.equal(state.auditEvents[0].action, 'tenant.entitlement.changed');
  assert.deepEqual(state.auditEvents[0].previousState, { enabled: false });
  assert.deepEqual(state.auditEvents[0].newState, { enabled: true });
  assert.equal(state.auditEvents[0].actorUserId, null);
  assert.deepEqual(state.auditEvents[0].metadata, { actorType: 'platform_operator' });

  await state.service.setEntitlement({
    operatorContext: { kind: 'trusted' },
    tenantId: TENANT_A,
    capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
    enabled: true,
    correlationId: CORRELATION,
  });
  assert.equal(state.auditEvents.length, 1);

  await state.service.setEntitlement({
    operatorContext: { kind: 'trusted' },
    tenantId: TENANT_B,
    capabilityId: CAPABILITY.MICROSOFT_DIRECTORY,
    enabled: false,
    correlationId: CORRELATION,
  });
  assert.equal(state.records.has(`${TENANT_B}:${CAPABILITY.MICROSOFT_DIRECTORY}`), false);

  await assert.rejects(
    state.service.setEntitlement({
      operatorContext: { kind: 'trusted' },
      tenantId: TENANT_A,
      capabilityId: 'microsoft.unknown',
      enabled: true,
      correlationId: CORRELATION,
    }),
    EntitlementInputError,
  );
});
