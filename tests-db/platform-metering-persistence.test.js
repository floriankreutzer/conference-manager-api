import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import {
  createPostgresPlatformMeteringRepository,
  createPostgresPlatformUsageSource,
} from '../src/persistence/postgres/platform-metering-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = 'a1111111-1111-4111-8111-111111111111';
const TENANT_B = 'a2222222-2222-4222-8222-222222222222';
const OPERATOR_ID = 'a3333333-3333-4333-8333-333333333333';
const EVENT_KEY_A = 'a'.repeat(64);
const EVENT_KEY_B = 'b'.repeat(64);
const EVENT_KEY_C = 'c'.repeat(64);
const EVENT_KEY_D = '4'.repeat(64);
const EVENT_KEY_E = '5'.repeat(64);
const PAYLOAD_DIGEST_A = '6'.repeat(64);
const PAYLOAD_DIGEST_B = '7'.repeat(64);
const QUOTA_OPERATION_A = 'a4444444-4444-4444-8444-444444444444';
const QUOTA_OPERATION_B = 'a5555555-5555-4555-8555-555555555555';
const QUOTA_OPERATION_C = 'a6666666-6666-4666-8666-666666666666';
const QUOTA_OPERATION_D = 'a7777777-7777-4777-8777-777777777777';
const REQUEST_DIGEST_A = 'd'.repeat(64);
const REQUEST_DIGEST_B = 'e'.repeat(64);
const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2026-09-01T00:00:00.000Z';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function setTriggers(pool, enabled) {
  const action = enabled ? 'ENABLE' : 'DISABLE';
  for (const table of [
    'platform_quota_operation_receipts',
    'platform_operational_quotas',
    'platform_metering_period_revisions',
    'platform_metering_periods',
    'platform_metering_events',
  ]) {
    await pool.query(`ALTER TABLE ${table} ${action} TRIGGER USER`);
  }
}

async function resetFixtures(pool) {
  await setTriggers(pool, false);
  try {
    await pool.query(
      'DELETE FROM platform_quota_operation_receipts WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B]],
    );
    await pool.query(
      'DELETE FROM platform_operational_quotas WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B]],
    );
    await pool.query(
      'DELETE FROM platform_metering_period_revisions WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B]],
    );
    await pool.query(
      'DELETE FROM platform_metering_periods WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B]],
    );
    await pool.query(
      'DELETE FROM platform_metering_events WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B]],
    );
  } finally {
    await setTriggers(pool, true);
  }
  await pool.query('DROP TABLE IF EXISTS platform_quota_audit_probe');
  await pool.query('DELETE FROM platform_operator_tenant_scopes WHERE operator_id = $1', [OPERATOR_ID]);
  await pool.query('DELETE FROM platform_operators WHERE id = $1', [OPERATOR_ID]);
  await clearSaas3TestState(pool);
  await removeSaas2TenantAdministrationFixtures(pool, [TENANT_A, TENANT_B]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
}

async function seedAuthority(pool) {
  await pool.query(
    `INSERT INTO tenants (id, display_name, status)
     VALUES ($1, 'Metering A', 'active'), ($2, 'Metering B', 'active')`,
    [TENANT_A, TENANT_B],
  );
  await pool.query(
    `INSERT INTO platform_operators (
       id, provider, provider_tenant_reference, provider_subject_reference,
       status, scope_mode, roles, security_version
     )
     VALUES (
       $1, 'test_oidc', 'platform-test', 'quota-operator',
       'active', 'allowlist', ARRAY['platform_tenant_operator'], 1
     )`,
    [OPERATOR_ID],
  );
  await pool.query(
    `INSERT INTO platform_operator_tenant_scopes (operator_id, tenant_id)
     VALUES ($1, $2)`,
    [OPERATOR_ID, TENANT_A],
  );
  const result = await pool.query(
    'SELECT security_version FROM platform_operators WHERE id = $1',
    [OPERATOR_ID],
  );
  return Number(result.rows[0].security_version);
}

function event(overrides = {}) {
  return {
    tenantId: TENANT_A,
    sourceEventKey: EVENT_KEY_A,
    payloadDigest: PAYLOAD_DIGEST_A,
    eventType: 'request.created',
    dimension: 'requests_created',
    units: 1,
    occurredAt: '2026-08-02T10:00:00.000Z',
    recordedAt: '2026-08-02T10:00:01.000Z',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  };
}

function values(overrides = {}) {
  return {
    active_users: 4,
    active_rooms: 3,
    requests_created: 5,
    bookings_confirmed: 2,
    integration_operations: 1,
    ...overrides,
  };
}

function reconciliation(overrides = {}) {
  return {
    tenantId: TENANT_A,
    periods: [{
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      dataState: 'complete',
      measuredAt: '2026-08-10T00:00:00.000Z',
      eventWatermark: '2026-08-10T00:00:00.000Z',
      values: values(),
    }],
    reconciledAt: '2026-08-10T00:01:00.000Z',
    auditEventFor: () => ({ operation: 'metering_reconciliation' }),
    ...overrides,
  };
}

function quotaInput(operatorSecurityVersion, overrides = {}) {
  return {
    tenantId: TENANT_A,
    operatorId: OPERATOR_ID,
    operatorSecurityVersion,
    dimension: 'requests_created',
    state: 'configured',
    softLimit: 10,
    hardLimit: 12,
    expectedRevision: 0,
    idempotencyKey: QUOTA_OPERATION_A,
    requestDigest: REQUEST_DIGEST_A,
    auditEventFor: ({ previousQuota, nextQuota }) => ({ previousQuota, nextQuota }),
    ...overrides,
  };
}

async function latestEventWatermark(pool, tenantId, periodStart = PERIOD_START) {
  const result = await pool.query(
    `SELECT MAX(ingested_at) AS watermark
     FROM platform_metering_events
     WHERE tenant_id = $1 AND period_start = $2`,
    [tenantId, periodStart],
  );
  if (!result.rows[0].watermark) throw new Error('METERING_EVENT_WATERMARK_REQUIRED');
  return new Date(result.rows[0].watermark).toISOString();
}

function instantAfter(value, milliseconds = 1_000) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

test('Platform metering PostgreSQL ledger, reconciliation and quota invariants', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditCalls = [];
  let rejectAudit = false;
  const auditRepository = {
    async appendWithClient(client, auditEvent, { expectedTargetTenantId } = {}) {
      assert.equal(expectedTargetTenantId, TENANT_A);
      auditCalls.push({ auditEvent, expectedTargetTenantId });
      await client.query(
        `INSERT INTO platform_quota_audit_probe (tenant_id, payload)
         VALUES ($1, $2::jsonb)`,
        [expectedTargetTenantId, JSON.stringify(auditEvent)],
      );
      if (rejectAudit) throw new Error('AUDIT_PROBE_REJECTED');
      return Object.freeze({ sequence: auditCalls.length });
    },
  };
  const repository = createPostgresPlatformMeteringRepository(pool, { auditRepository });
  let operatorSecurityVersion;

  t.after(async () => {
    try {
      await resetFixtures(pool);
    } finally {
      await pool.end();
    }
  });

  await migrateUp(pool);
  await resetFixtures(pool);
  await pool.query(`
    CREATE TABLE platform_quota_audit_probe (
      id BIGSERIAL PRIMARY KEY,
      tenant_id UUID NOT NULL,
      payload JSONB NOT NULL
    )
  `);
  operatorSecurityVersion = await seedAuthority(pool);

  await t.test('concurrent event replay increments one Tenant period exactly once', async () => {
    const receipts = await Promise.all([
      repository.recordEvent(event()),
      repository.recordEvent(event()),
    ]);
    assert.deepEqual(receipts.map(({ status }) => status).sort(), ['duplicate', 'recorded']);

    const tenantA = await repository.readPeriod({
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    });
    assert.equal(tenantA.dataState, 'partial');
    assert.equal(tenantA.values.requests_created, 1);
    assert.equal(tenantA.values.active_users, null);
    assert.deepEqual(tenantA.quotas.map(({ revision }) => revision), [0, 0, 0, 0, 0]);

    const tenantB = await repository.readPeriod({
      tenantId: TENANT_B,
      periodStart: PERIOD_START,
    });
    assert.equal(tenantB.dataState, 'unknown');
    assert.deepEqual(Object.values(tenantB.values), [null, null, null, null, null]);

    assert.equal((await repository.recordEvent(event({
      tenantId: TENANT_B,
    }))).status, 'recorded');
    assert.equal((await repository.recordEvent(event({
      payloadDigest: '8'.repeat(64),
    }))).status, 'conflict');
    assert.equal((await repository.readPeriod({
      tenantId: TENANT_A,
      periodStart: PERIOD_START,
    })).values.requests_created, 1);
    assert.equal((await repository.readPeriod({
      tenantId: TENANT_B,
      periodStart: PERIOD_START,
    })).values.requests_created, 1);

    const sameRecordedAt = '2026-08-02T10:00:02.000Z';
    const distinct = await Promise.all([
      repository.recordEvent(event({
        tenantId: TENANT_B,
        sourceEventKey: EVENT_KEY_D,
        payloadDigest: '9'.repeat(64),
        recordedAt: sameRecordedAt,
      })),
      repository.recordEvent(event({
        tenantId: TENANT_B,
        sourceEventKey: EVENT_KEY_E,
        payloadDigest: '0'.repeat(64),
        recordedAt: sameRecordedAt,
      })),
    ]);
    assert.deepEqual(distinct, [{ status: 'recorded' }, { status: 'recorded' }]);
    assert.equal((await repository.readPeriod({
      tenantId: TENANT_B,
      periodStart: PERIOD_START,
    })).values.requests_created, 3);
  });

  await t.test('authoritative source reads are server-derived and producer readiness is fail-closed', async () => {
    const ready = createPostgresPlatformUsageSource(pool, { counterProducersReady: true });
    const unready = createPostgresPlatformUsageSource(pool, { counterProducersReady: false });
    const currentStartDate = new Date();
    currentStartDate.setUTCDate(1);
    currentStartDate.setUTCHours(0, 0, 0, 0);
    const currentEndDate = new Date(currentStartDate);
    currentEndDate.setUTCMonth(currentEndDate.getUTCMonth() + 1);
    const currentPeriodStart = currentStartDate.toISOString();
    const currentPeriodEnd = currentEndDate.toISOString();
    const readySnapshot = await ready.readPeriod({
      tenantId: TENANT_A,
      periodStart: currentPeriodStart,
      periodEnd: currentPeriodEnd,
    });
    assert.match(readySnapshot.eventWatermark, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      readySnapshot.values.requests_created,
      currentPeriodStart === PERIOD_START ? 1 : 0,
    );
    assert.equal(readySnapshot.values.bookings_confirmed, 0);
    assert.equal(readySnapshot.dataState, 'complete');
    const unreadySnapshot = await unready.readPeriod({
      tenantId: TENANT_A,
      periodStart: currentPeriodStart,
      periodEnd: currentPeriodEnd,
    });
    assert.equal(unreadySnapshot.dataState, 'partial');
    await assert.rejects(
      ready.readPeriod({
        tenantId: 'a7777777-7777-4777-8777-777777777777',
        periodStart: currentPeriodStart,
        periodEnd: currentPeriodEnd,
      }),
      { message: 'PLATFORM_METERING_TENANT_NOT_FOUND' },
    );
  });

  await t.test('reconciliation is serialized, replay-safe and explicit about stale or unknown data', async () => {
    const firstWatermark = await latestEventWatermark(pool, TENANT_A);
    const firstReconciliation = reconciliation({
      periods: [{
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        dataState: 'complete',
        measuredAt: firstWatermark,
        eventWatermark: firstWatermark,
        values: values({
          requests_created: 1,
          bookings_confirmed: 0,
          integration_operations: 0,
        }),
      }],
      reconciledAt: instantAfter(firstWatermark),
    });
    const receipts = await Promise.all([
      repository.reconcilePeriods(firstReconciliation),
      repository.reconcilePeriods(firstReconciliation),
    ]);
    assert.deepEqual(receipts, [
      { status: 'reconciled', periodCount: 1 },
      { status: 'reconciled', periodCount: 1 },
    ]);
    let row = await pool.query(
      `SELECT revision, data_state, requests_created
       FROM platform_metering_periods
       WHERE tenant_id = $1 AND period_start = $2`,
      [TENANT_A, PERIOD_START],
    );
    assert.deepEqual({
      revision: Number(row.rows[0].revision),
      state: row.rows[0].data_state,
      requests: Number(row.rows[0].requests_created),
    }, { revision: 2, state: 'complete', requests: 1 });

    await repository.recordEvent(event({
      sourceEventKey: EVENT_KEY_B,
      payloadDigest: PAYLOAD_DIGEST_B,
      eventType: 'booking.confirmed',
      dimension: 'bookings_confirmed',
      occurredAt: '2026-08-11T00:00:00.000Z',
      recordedAt: '2026-08-11T00:00:01.000Z',
    }));
    const late = await repository.readPeriod({ tenantId: TENANT_A, periodStart: PERIOD_START });
    assert.equal(late.dataState, 'partial');
    assert.equal(late.values.bookings_confirmed, 1);

    const secondWatermark = await latestEventWatermark(pool, TENANT_A);
    await repository.reconcilePeriods(reconciliation({
      periods: [{
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        dataState: 'complete',
        measuredAt: secondWatermark,
        eventWatermark: secondWatermark,
        values: values({
          requests_created: 1,
          bookings_confirmed: 1,
          integration_operations: 0,
        }),
      }],
      reconciledAt: instantAfter(secondWatermark),
    }));
    const complete = await repository.readPeriod({ tenantId: TENANT_A, periodStart: PERIOD_START });
    assert.equal(complete.dataState, 'complete');
    assert.equal(complete.values.bookings_confirmed, 1);

    const staleWatermark = new Date(Date.parse(secondWatermark) - 1).toISOString();
    const stale = await repository.reconcilePeriods(reconciliation({
      periods: [{
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        dataState: 'complete',
        measuredAt: secondWatermark,
        eventWatermark: staleWatermark,
        values: values({
          requests_created: 1,
          bookings_confirmed: 1,
          integration_operations: 0,
        }),
      }],
      reconciledAt: instantAfter(secondWatermark, 2_000),
      auditEventFor: () => {
        throw new Error('STALE_RECONCILIATION_MUST_NOT_AUDIT_SUCCESS');
      },
    }));
    assert.deepEqual(stale, { status: 'watermark_conflict', periodStart: PERIOD_START });

    await repository.reconcilePeriods(reconciliation({
      periods: [{
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        dataState: 'unknown',
        measuredAt: null,
        eventWatermark: null,
        values: values({
          active_users: null,
          active_rooms: null,
          requests_created: null,
          bookings_confirmed: null,
          integration_operations: null,
        }),
      }],
      reconciledAt: instantAfter(secondWatermark, 2_000),
    }));
    const partial = await repository.readPeriod({ tenantId: TENANT_A, periodStart: PERIOD_START });
    assert.equal(partial.dataState, 'partial');
    assert.equal(partial.values.requests_created, 1);
    const provenance = await pool.query(
      `SELECT data_state, event_watermark, reconciled_at
       FROM platform_metering_period_revisions
       WHERE tenant_id = $1 AND period_start = $2
       ORDER BY revision`,
      [TENANT_A, PERIOD_START],
    );
    assert.equal(provenance.rowCount >= 3, true);
    assert.equal(provenance.rows.some(({ data_state }) => data_state === 'complete'), true);
    const currentProvenance = await pool.query(
      `SELECT event_watermark, reconciled_at
       FROM platform_metering_periods
       WHERE tenant_id = $1 AND period_start = $2`,
      [TENANT_A, PERIOD_START],
    );
    assert.notEqual(currentProvenance.rows[0].event_watermark, null);
    assert.notEqual(currentProvenance.rows[0].reconciled_at, null);

    await repository.reconcilePeriods({
      tenantId: TENANT_A,
      periods: [{
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-08-01T00:00:00.000Z',
        dataState: 'unknown',
        measuredAt: null,
        eventWatermark: null,
        values: values({
          active_users: null,
          active_rooms: null,
          requests_created: null,
          bookings_confirmed: null,
          integration_operations: null,
        }),
      }],
      reconciledAt: instantAfter(secondWatermark, 2_000),
      auditEventFor: () => ({ operation: 'metering_reconciliation' }),
    });
    assert.equal((await repository.readPeriod({
      tenantId: TENANT_A,
      periodStart: '2026-07-01T00:00:00.000Z',
    })).dataState, 'unknown');
  });

  await t.test('quota CAS and idempotency serialize and audit in the same transaction', async () => {
    const auditBefore = auditCalls.length;
    const probeBefore = (await pool.query(
      'SELECT COUNT(*)::integer AS count FROM platform_quota_audit_probe',
    )).rows[0].count;
    const sameOperation = await Promise.all([
      repository.setOperationalQuota(quotaInput(operatorSecurityVersion)),
      repository.setOperationalQuota(quotaInput(operatorSecurityVersion)),
    ]);
    assert.deepEqual(sameOperation.map(({ status }) => status).sort(), ['replay', 'updated']);
    assert.equal(auditCalls.length, auditBefore + 1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::integer AS count FROM platform_quota_audit_probe',
    )).rows[0].count, probeBefore + 1);

    const differentOperations = await Promise.all([
      repository.setOperationalQuota(quotaInput(operatorSecurityVersion, {
        expectedRevision: 1,
        idempotencyKey: QUOTA_OPERATION_B,
        requestDigest: REQUEST_DIGEST_B,
        softLimit: 11,
      })),
      repository.setOperationalQuota(quotaInput(operatorSecurityVersion, {
        expectedRevision: 1,
        idempotencyKey: QUOTA_OPERATION_C,
        requestDigest: 'f'.repeat(64),
        softLimit: 9,
      })),
    ]);
    assert.deepEqual(
      differentOperations.map(({ status }) => status).sort(),
      ['conflict', 'updated'],
    );
    assert.equal(auditCalls.length, auditBefore + 2);

    const conflict = await repository.setOperationalQuota(quotaInput(operatorSecurityVersion, {
      hardLimit: 13,
      requestDigest: REQUEST_DIGEST_B,
    }));
    assert.deepEqual(conflict, { status: 'idempotency_conflict' });

    const period = await repository.readPeriod({ tenantId: TENANT_A, periodStart: PERIOD_START });
    const quota = period.quotas.find(({ dimension }) => dimension === 'requests_created');
    assert.equal(quota.state, 'configured');
    assert.equal(quota.revision, 2);
    assert.equal([9, 11].includes(quota.softLimit), true);
  });

  await t.test('target scope and audit failure fail closed without quota or receipt changes', async () => {
    await assert.rejects(
      repository.setOperationalQuota(quotaInput(operatorSecurityVersion, {
        tenantId: TENANT_B,
        dimension: 'active_users',
        idempotencyKey: QUOTA_OPERATION_C,
        requestDigest: '1'.repeat(64),
      })),
      { message: 'PLATFORM_OPERATIONAL_QUOTA_TARGET_DENIED' },
    );

    rejectAudit = true;
    const probeBefore = Number((await pool.query(
      'SELECT COUNT(*) AS count FROM platform_quota_audit_probe',
    )).rows[0].count);
    await assert.rejects(
      repository.setOperationalQuota(quotaInput(operatorSecurityVersion, {
        dimension: 'active_users',
        idempotencyKey: QUOTA_OPERATION_D,
        requestDigest: '2'.repeat(64),
      })),
      { message: 'AUDIT_PROBE_REJECTED' },
    );
    rejectAudit = false;
    assert.equal(Number((await pool.query(
      'SELECT COUNT(*) AS count FROM platform_quota_audit_probe',
    )).rows[0].count), probeBefore);
    assert.equal((await pool.query(
      `SELECT 1 FROM platform_operational_quotas
       WHERE tenant_id = $1 AND dimension = 'active_users'`,
      [TENANT_A],
    )).rowCount, 0);
    assert.equal((await pool.query(
      'SELECT 1 FROM platform_quota_operation_receipts WHERE idempotency_key = $1',
      [QUOTA_OPERATION_D],
    )).rowCount, 0);
  });

  await t.test('constraints reject tampering, early retention deletion and malformed ledger pairs', async () => {
    await assert.rejects(
      pool.query(
        `UPDATE platform_metering_events SET units = 2
         WHERE tenant_id = $1 AND source_event_key = $2`,
        [TENANT_A, EVENT_KEY_A],
      ),
      (error) => error.code === '55000',
    );
    await assert.rejects(
      pool.query(
        `DELETE FROM platform_metering_events
         WHERE tenant_id = $1 AND source_event_key = $2`,
        [TENANT_A, EVENT_KEY_A],
      ),
      (error) => error.code === '55000',
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform_operational_quotas SET hard_limit = 99
         WHERE tenant_id = $1 AND dimension = 'requests_created'`,
        [TENANT_A],
      ),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform_quota_operation_receipts SET request_digest = $3
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [TENANT_A, QUOTA_OPERATION_A, '3'.repeat(64)],
      ),
      (error) => error.code === '55000',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform_metering_events (
           tenant_id, source_event_key, payload_digest, event_type, dimension, units,
           occurred_at, recorded_at, period_start, period_end, retain_until
         )
         VALUES (
           $1, $2, $3, 'request.created', 'bookings_confirmed', 1,
           $4, $4, $5, $6, GREATEST($6::timestamptz, clock_timestamp())
             + INTERVAL '24 months'
         )`,
        [
          TENANT_A,
          EVENT_KEY_C,
          '3'.repeat(64),
          '2026-08-03T00:00:00.000Z',
          PERIOD_START,
          PERIOD_END,
        ],
      ),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform_metering_periods
         SET event_watermark = NULL,
             measured_at = NULL,
             reconciled_at = NULL,
             data_state = 'unknown',
             active_users = NULL,
             active_rooms = NULL,
             requests_created = NULL,
             bookings_confirmed = NULL,
             integration_operations = NULL,
             revision = revision + 1
         WHERE tenant_id = $1 AND period_start = $2`,
        [TENANT_A, PERIOD_START],
      ),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform_metering_period_revisions
         SET data_state = data_state
         WHERE tenant_id = $1 AND period_start = $2`,
        [TENANT_A, PERIOD_START],
      ),
      (error) => error.code === '55000',
    );
  });

  await t.test('migration rollback refuses retained state and is reversible after reviewed cleanup', async () => {
    await assert.rejects(
      rollbackToVersion(pool, 33),
      (error) => error.code === '55000'
        && error.message.includes('PLATFORM_METERING_RUNTIME_ROLLBACK_REQUIRES_REVIEW'),
    );
    await resetFixtures(pool);
    assert.equal(await rollbackToVersion(pool, 33), true);
    assert.equal((await pool.query(
      `SELECT to_regclass('platform_metering_events') AS relation`,
    )).rows[0].relation, null);
    await migrateUp(pool);
    await pool.query(`
      CREATE TABLE platform_quota_audit_probe (
        id BIGSERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    operatorSecurityVersion = await seedAuthority(pool);
  });
});
