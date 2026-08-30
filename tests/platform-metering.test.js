import assert from 'node:assert/strict';
import test from 'node:test';
import {
  METERING_DATA_STATE,
  OPERATIONAL_QUOTA_DECISION,
  OPERATIONAL_QUOTA_POLICY_STATE,
  PLATFORM_QUOTA_CONFIRMATION_ACTION,
  PLATFORM_USAGE_DIMENSION,
  PLATFORM_USAGE_EVENT,
  createPlatformMeteringService,
  createPlatformUsageEventSourceAuthority,
} from '../src/platform/application/metering-service.js';
import {
  PLATFORM_PERMISSION,
  createPlatformAuthorizationPolicy,
} from '../src/platform/identity/policy.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const OPERATOR_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_ID = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = Object.freeze({ operatorId: 'operator-a' });
const QUOTA_PRINCIPAL = Object.freeze({
  operatorId: OPERATOR_ID,
  securityVersion: 1,
  permissions: [PLATFORM_PERMISSION.QUOTA_MANAGE],
  assurance: { level: 'step_up' },
  session: { stepUpExpiresAt: '2026-08-28T12:05:00.000Z' },
});
const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2026-09-01T00:00:00.000Z';
const DIMENSIONS = Object.values(PLATFORM_USAGE_DIMENSION);
const SOURCE_CONTEXT = Object.freeze({ source: 'test_domain_event' });

function usageValues(overrides = {}) {
  return {
    [PLATFORM_USAGE_DIMENSION.ACTIVE_USERS]: 4,
    [PLATFORM_USAGE_DIMENSION.ACTIVE_ROOMS]: 3,
    [PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED]: 9,
    [PLATFORM_USAGE_DIMENSION.BOOKINGS_CONFIRMED]: 5,
    [PLATFORM_USAGE_DIMENSION.INTEGRATION_OPERATIONS]: 8,
    ...overrides,
  };
}

function quotaPolicies(overrides = {}) {
  return DIMENSIONS.map((dimension) => ({
    dimension,
    state: OPERATIONAL_QUOTA_POLICY_STATE.NOT_CONFIGURED,
    softLimit: null,
    hardLimit: null,
    revision: 0,
    ...(overrides[dimension] || {}),
  }));
}

function periodRecord(overrides = {}) {
  return {
    tenantId: TENANT_A,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    dataState: METERING_DATA_STATE.COMPLETE,
    measuredAt: '2026-08-28T11:59:00.000Z',
    reconciledAt: '2026-08-28T12:00:00.000Z',
    values: usageValues(),
    quotas: quotaPolicies(),
    ...overrides,
  };
}

function harness({
  readPeriod = () => periodRecord(),
  readSource = () => ({
    dataState: METERING_DATA_STATE.COMPLETE,
    measuredAt: '2026-08-28T11:59:00.000Z',
    eventWatermark: '2026-08-28T11:59:00.000Z',
    values: usageValues(),
  }),
  permissionPolicy = null,
  authorize = () => true,
  authorizeTenant = () => true,
  authorizeSource = (candidate) => candidate === SOURCE_CONTEXT,
  setQuota = null,
  reconcileResult = null,
} = {}) {
  const events = new Map();
  const calls = [];
  const repository = {
    async recordEvent(input) {
      calls.push(['recordEvent', input]);
      const existing = events.get(input.sourceEventKey);
      if (existing) {
        return { status: existing === input.payloadDigest ? 'duplicate' : 'conflict' };
      }
      events.set(input.sourceEventKey, input.payloadDigest);
      return { status: 'recorded' };
    },
    async readPeriod(input) {
      calls.push(['readPeriod', input]);
      const result = readPeriod(input);
      if (input.auditEventFor) input.auditEventFor(result);
      return result;
    },
    async reconcilePeriods(input) {
      calls.push(['reconcilePeriods', input]);
      if (reconcileResult) return reconcileResult(input);
      input.auditEventFor();
      return { status: 'reconciled', periodCount: input.periods.length };
    },
    async setOperationalQuota(input) {
      calls.push(['setOperationalQuota', input]);
      if (setQuota) return setQuota(input);
      input.auditEventFor({
        previousQuota: {
          dimension: input.dimension,
          state: OPERATIONAL_QUOTA_POLICY_STATE.NOT_CONFIGURED,
          softLimit: null,
          hardLimit: null,
          revision: 0,
        },
        nextQuota: {
          dimension: input.dimension,
          state: input.state,
          softLimit: input.softLimit,
          hardLimit: input.hardLimit,
          revision: input.expectedRevision + 1,
        },
      });
      return {
        status: 'updated',
        quota: {
          state: input.state,
          softLimit: input.softLimit,
          hardLimit: input.hardLimit,
          revision: input.expectedRevision + 1,
        },
      };
    },
  };
  const service = createPlatformMeteringService({
    repository,
    usageSource: {
      async readPeriod(input) {
        calls.push(['readSource', input]);
        return readSource(input);
      },
    },
    authorizationPolicy: permissionPolicy || {
      async authorize(principal, permission) {
        calls.push(['authorize', principal, permission]);
        return authorize(principal, permission);
      },
    },
    tenantTargetPolicy: {
      async authorize(principal, tenantId) {
        calls.push(['authorizeTenant', principal, tenantId]);
        return authorizeTenant(principal, tenantId);
      },
    },
    auditService: {
      createEvent(input) {
        calls.push(['createAuditEvent', input]);
        return Object.freeze({ ...input, audit: true });
      },
    },
    usageEventSourcePolicy: {
      async authorize(sourceContext, context) {
        calls.push(['authorizeSource', sourceContext, context]);
        return authorizeSource(sourceContext, context);
      },
    },
    clock: () => NOW,
  });
  return { calls, service };
}

function quotaMutation(overrides = {}) {
  return {
    operatorContext: QUOTA_PRINCIPAL,
    tenantId: TENANT_A,
    dimension: PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED,
    state: OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED,
    softLimit: 10,
    hardLimit: 12,
    expectedRevision: 0,
    reason: 'Pilot operations guardrail',
    confirmation: {
      action: PLATFORM_QUOTA_CONFIRMATION_ACTION,
      tenantId: TENANT_A,
      dimension: PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED,
    },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_ID,
    ...overrides,
  };
}

test('usage events are allowlisted, unit-valued and globally replay safe per Tenant', async () => {
  const values = harness();
  const event = {
    sourceContext: SOURCE_CONTEXT,
    tenantId: TENANT_A,
    sourceEventId: EVENT_ID,
    eventType: PLATFORM_USAGE_EVENT.REQUEST_CREATED,
    occurredAt: '2026-08-01T00:00:00.000Z',
  };
  const results = await Promise.all([
    values.service.recordUsageEvent(event),
    values.service.recordUsageEvent(event),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['duplicate', 'recorded']);
  const writes = values.calls.filter(([name]) => name === 'recordEvent').map(([, input]) => input);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].units, 1);
  assert.equal(writes[0].dimension, PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED);
  assert.equal(writes[0].periodStart, PERIOD_START);
  assert.match(writes[0].sourceEventKey, /^[a-f0-9]{64}$/);
  assert.match(writes[0].payloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(writes[0].sourceEventKey.includes(EVENT_ID), false);
  assert.equal(writes[0].sourceEventKey, writes[1].sourceEventKey);

  await values.service.recordUsageEvent({ ...event, tenantId: TENANT_B });
  const tenantBWrite = values.calls.filter(([name]) => name === 'recordEvent').at(-1)[1];
  assert.notEqual(tenantBWrite.sourceEventKey, writes[0].sourceEventKey);

  await assert.rejects(
    values.service.recordUsageEvent({
      ...event,
      eventType: PLATFORM_USAGE_EVENT.BOOKING_CONFIRMED,
    }),
    {
      name: 'PlatformOperationConflictError',
      message: 'PLATFORM_METERING_EVENT_REPLAY_CONFLICT',
    },
  );
  const conflictingWrite = values.calls.filter(([name]) => name === 'recordEvent').at(-1)[1];
  assert.equal(conflictingWrite.sourceEventKey, writes[0].sourceEventKey);
  assert.notEqual(conflictingWrite.payloadDigest, writes[0].payloadDigest);
});

test('trusted producer binding fixes event types outside browser-controlled input', async () => {
  const authority = createPlatformUsageEventSourceAuthority();
  const values = harness({
    authorizeSource: (candidate, context) => authority.policy.authorize(candidate, context),
  });
  const recorder = authority.bindRecorder(values.service);
  await recorder.recordRequestCreated({
    tenantId: TENANT_A,
    sourceEventId: EVENT_ID,
    occurredAt: '2026-08-28T11:00:00.000Z',
  });
  const write = values.calls.find(([name]) => name === 'recordEvent')[1];
  assert.equal(write.eventType, PLATFORM_USAGE_EVENT.REQUEST_CREATED);
  await assert.rejects(
    async () => recorder.recordBookingConfirmed({
      tenantId: TENANT_A,
      sourceEventId: EVENT_ID,
      occurredAt: '2026-08-28T11:00:00.000Z',
      eventType: 'attacker.selected',
    }),
    { message: 'PLATFORM_METERING_EVENT_INPUT_INVALID' },
  );
});

test('usage recording rejects browser-shaped counters, unknown events and future timestamps', async () => {
  const values = harness();
  const event = {
    sourceContext: SOURCE_CONTEXT,
    tenantId: TENANT_A,
    sourceEventId: EVENT_ID,
    eventType: PLATFORM_USAGE_EVENT.BOOKING_CONFIRMED,
    occurredAt: '2026-08-28T11:00:00.000Z',
  };
  await assert.rejects(
    values.service.recordUsageEvent({ ...event, units: 10_000 }),
    { message: 'PLATFORM_METERING_EVENT_INPUT_INVALID' },
  );
  await assert.rejects(
    values.service.recordUsageEvent({ ...event, eventType: 'browser.counter' }),
    { message: 'PLATFORM_METERING_EVENT_TYPE_INVALID' },
  );
  await assert.rejects(
    values.service.recordUsageEvent({ ...event, occurredAt: '2026-08-28T12:00:00.001Z' }),
    { message: 'PLATFORM_METERING_EVENT_TIME_INVALID' },
  );
  const denied = harness({ authorizeSource: () => false });
  await assert.rejects(
    denied.service.recordUsageEvent(event),
    { message: 'PLATFORM_METERING_EVENT_SOURCE_DENIED' },
  );
  assert.equal(denied.calls.some(([name]) => name === 'recordEvent'), false);
  assert.equal(values.calls.some(([name]) => name === 'recordEvent'), false);
});

test('Platform usage reads require metering permission and separate Tenant target scope', async () => {
  const values = harness();
  const result = await values.service.getUsagePeriod({
    operatorContext: PRINCIPAL,
    tenantId: TENANT_A,
    periodStart: PERIOD_START,
  });
  assert.deepEqual(values.calls.slice(0, 3).map(([name]) => name), [
    'authorize',
    'authorizeTenant',
    'readPeriod',
  ]);
  assert.equal(values.calls[0][2], PLATFORM_PERMISSION.METERING_READ);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.tenantId, TENANT_A);
  assert.equal(result.period.timeZone, 'UTC');
  assert.deepEqual(result.dimensions.map(({ dimension }) => dimension), DIMENSIONS);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.dimensions), true);
  const readAudit = values.calls.find(([name]) => name === 'createAuditEvent')[1];
  assert.equal(readAudit.action, 'platform.metering.read');
  assert.equal(readAudit.targetTenantId, TENANT_A);
  assert.equal(readAudit.targetId, PERIOD_START);

  const denied = harness({
    authorizeTenant() {
      throw new Error('TARGET_DENIED');
    },
  });
  await assert.rejects(
    denied.service.getUsagePeriod({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_B,
      periodStart: PERIOD_START,
    }),
    { message: 'TARGET_DENIED' },
  );
  assert.equal(denied.calls.some(([name]) => name === 'readPeriod'), false);
});

test('metering reads accept only the dedicated canonical Platform permission', async () => {
  const allowed = harness({ permissionPolicy: createPlatformAuthorizationPolicy() });
  await allowed.service.getUsagePeriod({
    operatorContext: {
      permissions: [PLATFORM_PERMISSION.METERING_READ],
      assurance: { level: 'mfa' },
    },
    tenantId: TENANT_A,
    periodStart: PERIOD_START,
  });
  assert.equal(allowed.calls.some(([name]) => name === 'readPeriod'), true);

  const denied = harness({ permissionPolicy: createPlatformAuthorizationPolicy() });
  await assert.rejects(
    denied.service.getUsagePeriod({
      operatorContext: {
        permissions: [PLATFORM_PERMISSION.DIAGNOSTICS_READ],
        assurance: { level: 'mfa' },
      },
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    }),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_AUTHORIZATION_DENIED' },
  );
  assert.equal(denied.calls.some(([name]) => name === 'authorizeTenant'), false);
  assert.equal(denied.calls.some(([name]) => name === 'readPeriod'), false);

  const ambiguous = harness({ authorize: () => false });
  await assert.rejects(
    ambiguous.service.getUsagePeriod({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    }),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_OPERATION_DENIED' },
  );
  assert.equal(ambiguous.calls.some(([name]) => name === 'authorizeTenant'), false);
});

test('usage projections fail closed on cross-Tenant or non-minimized repository records', async () => {
  const mismatched = harness({ readPeriod: () => periodRecord({ tenantId: TENANT_B }) });
  await assert.rejects(
    mismatched.service.getUsagePeriod({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    }),
    { message: 'PLATFORM_METERING_PERIOD_SCOPE_MISMATCH' },
  );

  const disclosed = harness({
    readPeriod: () => ({ ...periodRecord(), requestTitle: 'Confidential launch' }),
  });
  await assert.rejects(
    disclosed.service.getUsagePeriod({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    }),
    { message: 'PLATFORM_METERING_PERIOD_RECORD_INVALID' },
  );
});

test('soft and hard operational quotas return restrictions, never authorization or entitlement', async () => {
  const requestsQuota = {
    state: OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED,
    softLimit: 10,
    hardLimit: 12,
    revision: 1,
  };
  const values = harness({
    readPeriod: () => periodRecord({
      quotas: quotaPolicies({
        [PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED]: requestsQuota,
      }),
    }),
  });
  const input = {
    tenantId: TENANT_A,
    dimension: PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED,
  };
  const within = await values.service.evaluateOperationalQuota({ ...input, requestedUnits: 1 });
  const soft = await values.service.evaluateOperationalQuota({ ...input, requestedUnits: 2 });
  const hard = await values.service.evaluateOperationalQuota({ ...input, requestedUnits: 4 });
  assert.deepEqual(
    [within.state, soft.state, hard.state],
    [
      OPERATIONAL_QUOTA_DECISION.WITHIN,
      OPERATIONAL_QUOTA_DECISION.SOFT_EXCEEDED,
      OPERATIONAL_QUOTA_DECISION.HARD_EXCEEDED,
    ],
  );
  assert.deepEqual(
    [within.restrictsAdditionalUsage, soft.restrictsAdditionalUsage, hard.restrictsAdditionalUsage],
    [false, false, true],
  );
  for (const result of [within, soft, hard]) {
    assert.equal('authorized' in result, false);
    assert.equal('entitled' in result, false);
    assert.equal('billing' in result, false);
    assert.equal('allowed' in result, false);
  }
});

test('missing usage or quota metadata is explicit and never silently permits or blocks', async () => {
  const partial = harness({
    readPeriod: () => periodRecord({
      dataState: METERING_DATA_STATE.PARTIAL,
      values: usageValues({ [PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED]: null }),
      quotas: quotaPolicies({
        [PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED]: {
          state: OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED,
          softLimit: 10,
          hardLimit: 12,
          revision: 1,
        },
      }),
    }),
  });
  const unknown = await partial.service.evaluateOperationalQuota({
    tenantId: TENANT_A,
    dimension: PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED,
    requestedUnits: 1,
  });
  assert.equal(unknown.state, OPERATIONAL_QUOTA_DECISION.UNKNOWN);
  assert.equal(unknown.restrictsAdditionalUsage, null);
  assert.equal(unknown.projectedValue, null);

  const noPolicy = await partial.service.evaluateOperationalQuota({
    tenantId: TENANT_A,
    dimension: PLATFORM_USAGE_DIMENSION.ACTIVE_USERS,
    requestedUnits: 1,
  });
  assert.equal(noPolicy.state, OPERATIONAL_QUOTA_DECISION.NOT_CONFIGURED);
  assert.equal(noPolicy.restrictsAdditionalUsage, false);
});

test('operational quota mutation requires dedicated step-up permission and Tenant target scope', async () => {
  const allowed = harness({
    permissionPolicy: createPlatformAuthorizationPolicy({ clock: () => NOW }),
  });
  const result = await allowed.service.setOperationalQuota(quotaMutation());
  assert.deepEqual(
    allowed.calls.slice(0, 3).map(([name]) => name),
    ['authorizeTenant', 'setOperationalQuota', 'createAuditEvent'],
  );
  assert.equal(result.status, 'updated');
  assert.equal(result.quota.revision, 1);
  assert.equal(result.quota.hardLimit, 12);
  assert.equal('authorized' in result, false);
  const write = allowed.calls.find(([name]) => name === 'setOperationalQuota')[1];
  assert.equal(write.operatorId, OPERATOR_ID);
  assert.equal(write.operatorSecurityVersion, 1);
  assert.match(write.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal('confirmation' in write, false);
  assert.equal('reason' in write, false);
  const audit = allowed.calls.find(([name]) => name === 'createAuditEvent')[1];
  assert.equal(audit.action, 'platform.tenant.quota.changed');
  assert.equal(audit.targetTenantId, TENANT_A);
  assert.equal(audit.targetId, PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED);
  assert.equal(audit.metadata.reason, 'Pilot operations guardrail');

  const wrongPermission = harness({
    permissionPolicy: createPlatformAuthorizationPolicy({ clock: () => NOW }),
  });
  await assert.rejects(
    wrongPermission.service.setOperationalQuota(quotaMutation({
      operatorContext: {
        ...QUOTA_PRINCIPAL,
        permissions: [PLATFORM_PERMISSION.METERING_READ],
      },
    })),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_AUTHORIZATION_DENIED' },
  );
  assert.equal(wrongPermission.calls.some(([name]) => name === 'authorizeTenant'), false);
  assert.equal(wrongPermission.calls.some(([name]) => name === 'setOperationalQuota'), false);

  const noStepUp = harness({
    permissionPolicy: createPlatformAuthorizationPolicy({ clock: () => NOW }),
  });
  await assert.rejects(
    noStepUp.service.setOperationalQuota(quotaMutation({
      operatorContext: {
        ...QUOTA_PRINCIPAL,
        assurance: { level: 'mfa' },
        session: { stepUpExpiresAt: null },
      },
    })),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_STEP_UP_REQUIRED' },
  );
  assert.equal(noStepUp.calls.some(([name]) => name === 'authorizeTenant'), false);

  const targetDenied = harness({
    permissionPolicy: createPlatformAuthorizationPolicy({ clock: () => NOW }),
    authorizeTenant: () => false,
  });
  await assert.rejects(
    targetDenied.service.setOperationalQuota(quotaMutation()),
    { name: 'PlatformOperationDeniedError', message: 'PLATFORM_OPERATION_DENIED' },
  );
  assert.equal(targetDenied.calls.some(([name]) => name === 'setOperationalQuota'), false);
});

test('quota mutation binds confirmation, revision, reason and idempotency before persistence', async () => {
  const values = harness();
  await assert.rejects(
    values.service.setOperationalQuota(quotaMutation({
      confirmation: {
        action: PLATFORM_QUOTA_CONFIRMATION_ACTION,
        tenantId: TENANT_B,
        dimension: PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED,
      },
    })),
    { message: 'PLATFORM_METERING_QUOTA_CONFIRMATION_INVALID' },
  );
  await assert.rejects(
    values.service.setOperationalQuota(quotaMutation({ expectedRevision: -1 })),
    { message: 'PLATFORM_METERING_QUOTA_REVISION_INVALID' },
  );
  await assert.rejects(
    values.service.setOperationalQuota(quotaMutation({ reason: '  ' })),
    { message: 'PLATFORM_METERING_QUOTA_REASON_INVALID' },
  );
  await assert.rejects(
    values.service.setOperationalQuota(quotaMutation({ idempotencyKey: EVENT_ID.slice(0, -1) })),
    { message: 'PLATFORM_METERING_IDEMPOTENCY_KEY_INVALID' },
  );
  await assert.rejects(
    values.service.setOperationalQuota(quotaMutation({
      state: OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED,
      softLimit: 13,
      hardLimit: 12,
    })),
    { message: 'PLATFORM_METERING_QUOTA_CHANGE_INVALID' },
  );
  assert.equal(values.calls.some(([name]) => name === 'setOperationalQuota'), false);
});

test('quota mutation preserves replay and optimistic-concurrency conflicts', async () => {
  const replay = harness({
    setQuota: (input) => ({
      status: 'replay',
      quota: {
        state: input.state,
        softLimit: input.softLimit,
        hardLimit: input.hardLimit,
        revision: 2,
      },
    }),
  });
  assert.equal((await replay.service.setOperationalQuota(quotaMutation({
    expectedRevision: 1,
  }))).status, 'replay');

  const revisionConflict = harness({
    setQuota: () => ({ status: 'conflict', currentRevision: 4 }),
  });
  await assert.rejects(
    revisionConflict.service.setOperationalQuota(quotaMutation()),
    {
      name: 'PlatformOperationConflictError',
      message: 'PLATFORM_METERING_QUOTA_REVISION_CONFLICT',
    },
  );

  const idempotencyConflict = harness({
    setQuota: () => ({ status: 'idempotency_conflict' }),
  });
  await assert.rejects(
    idempotencyConflict.service.setOperationalQuota(quotaMutation()),
    { name: 'PlatformOperationConflictError', message: 'PLATFORM_IDEMPOTENCY_KEY_CONFLICT' },
  );
});

test('reconciliation and bounded backfill derive values only from the trusted source port', async () => {
  const values = harness();
  const result = await values.service.backfillUsagePeriods({
    operatorContext: PRINCIPAL,
    tenantId: TENANT_A,
    fromPeriodStart: '2026-07-01T00:00:00.000Z',
    toPeriodStart: PERIOD_START,
  });
  assert.equal(values.calls[0][0], 'authorize');
  assert.equal(values.calls[0][2], PLATFORM_PERMISSION.RECOVERY_EXECUTE);
  assert.equal(values.calls[1][0], 'authorizeTenant');
  assert.equal(values.calls.filter(([name]) => name === 'readSource').length, 2);
  assert.equal(values.calls.filter(([name]) => name === 'reconcilePeriods').length, 1);
  assert.equal(result.periods.length, 2);
  const write = values.calls.find(([name]) => name === 'reconcilePeriods')[1];
  assert.deepEqual(write.periods[0].values, usageValues());
  const audit = values.calls.find(([name]) => name === 'createAuditEvent')[1];
  assert.equal(audit.action, 'platform.recovery.executed');
  assert.equal(audit.newState.periodCount, 2);

  await assert.rejects(
    values.service.backfillUsagePeriods({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      fromPeriodStart: '2024-01-01T00:00:00.000Z',
      toPeriodStart: '2026-08-01T00:00:00.000Z',
    }),
    { message: 'PLATFORM_METERING_BACKFILL_RANGE_INVALID' },
  );
});

test('invalid reconciliation source data aborts before any period is persisted', async () => {
  const values = harness({
    readSource: () => ({
      dataState: METERING_DATA_STATE.COMPLETE,
      measuredAt: '2026-08-28T11:59:00.000Z',
      eventWatermark: '2026-08-28T11:59:00.000Z',
      values: usageValues(),
      rawRequestIds: [EVENT_ID],
    }),
  });
  await assert.rejects(
    values.service.reconcileUsagePeriod({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    }),
    { message: 'PLATFORM_METERING_SOURCE_SNAPSHOT_INVALID' },
  );
  assert.equal(values.calls.some(([name]) => name === 'reconcilePeriods'), false);

  const missingWatermark = harness({
    readSource: () => ({
      dataState: METERING_DATA_STATE.COMPLETE,
      measuredAt: '2026-08-28T11:59:00.000Z',
      eventWatermark: null,
      values: usageValues(),
    }),
  });
  await assert.rejects(
    missingWatermark.service.reconcileUsagePeriod({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    }),
    { message: 'PLATFORM_METERING_EVENT_WATERMARK_INVALID' },
  );
  assert.equal(missingWatermark.calls.some(([name]) => name === 'reconcilePeriods'), false);
});

test('a stale source watermark is an explicit reconciliation conflict', async () => {
  const values = harness({
    reconcileResult: () => ({ status: 'watermark_conflict', periodStart: PERIOD_START }),
  });
  await assert.rejects(
    values.service.reconcileUsagePeriod({
      operatorContext: PRINCIPAL,
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    }),
    {
      name: 'PlatformOperationConflictError',
      message: 'PLATFORM_METERING_RECONCILIATION_WATERMARK_CONFLICT',
    },
  );
});
