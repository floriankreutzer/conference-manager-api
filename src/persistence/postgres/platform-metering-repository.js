import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const DIMENSION_ORDER = Object.freeze([
  'active_users',
  'active_rooms',
  'requests_created',
  'bookings_confirmed',
  'integration_operations',
]);
const DIMENSIONS = new Set(DIMENSION_ORDER);
const EVENT_DIMENSION = Object.freeze({
  'request.created': 'requests_created',
  'booking.confirmed': 'bookings_confirmed',
  'integration.operation.completed': 'integration_operations',
});
const DATA_STATES = new Set(['complete', 'partial', 'unknown']);
const QUOTA_STATES = new Set(['configured', 'not_configured']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SAFE_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_BATCH_PERIODS = 24;

function invalid(code) {
  throw new TypeError(code);
}

function requireUuid(value, code) {
  if (!isInternalUuid(value)) invalid(code);
  return value;
}

function requireInstant(value, code) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid(code);
  return value;
}

function instant(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function periodForStart(value) {
  const periodStart = requireInstant(value, 'PLATFORM_METERING_PERIOD_INVALID');
  const start = new Date(periodStart);
  if (
    start.getUTCDate() !== 1
    || start.getUTCHours() !== 0
    || start.getUTCMinutes() !== 0
    || start.getUTCSeconds() !== 0
    || start.getUTCMilliseconds() !== 0
  ) {
    invalid('PLATFORM_METERING_PERIOD_INVALID');
  }
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return Object.freeze({ start: periodStart, end: end.toISOString() });
}

function requirePeriod(periodStart, periodEnd) {
  const period = periodForStart(periodStart);
  if (period.end !== periodEnd) invalid('PLATFORM_METERING_PERIOD_INVALID');
  return period;
}

function requireValue(value, code = 'PLATFORM_METERING_VALUE_INVALID') {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) invalid(code);
  return value;
}

function databaseValue(value, code = 'PLATFORM_METERING_VALUE_INVALID') {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) invalid(code);
  return result;
}

function requireDimension(value) {
  if (!DIMENSIONS.has(value)) invalid('PLATFORM_METERING_DIMENSION_INVALID');
  return value;
}

function requireHash(value, code) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalid(code);
  return value;
}

function requireQuotaState(state, softLimit, hardLimit) {
  if (!QUOTA_STATES.has(state)) invalid('PLATFORM_OPERATIONAL_QUOTA_INVALID');
  requireValue(softLimit, 'PLATFORM_OPERATIONAL_QUOTA_INVALID');
  requireValue(hardLimit, 'PLATFORM_OPERATIONAL_QUOTA_INVALID');
  if (
    (state === 'configured' && softLimit === null && hardLimit === null)
    || (state === 'not_configured' && (softLimit !== null || hardLimit !== null))
    || (softLimit !== null && hardLimit !== null && softLimit > hardLimit)
  ) {
    invalid('PLATFORM_OPERATIONAL_QUOTA_INVALID');
  }
  return Object.freeze({ state, softLimit, hardLimit });
}

function requireRevision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid('PLATFORM_OPERATIONAL_QUOTA_REVISION_INVALID');
  }
  return value;
}

function valuesFromRow(row) {
  return Object.freeze({
    active_users: databaseValue(row?.active_users),
    active_rooms: databaseValue(row?.active_rooms),
    requests_created: databaseValue(row?.requests_created),
    bookings_confirmed: databaseValue(row?.bookings_confirmed),
    integration_operations: databaseValue(row?.integration_operations),
  });
}

function requireValues(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...DIMENSION_ORDER].sort().join(',')
  ) {
    invalid('PLATFORM_METERING_VALUES_INVALID');
  }
  return Object.freeze(Object.fromEntries(DIMENSION_ORDER.map((dimension) => {
    return [dimension, requireValue(value[dimension])];
  })));
}

function logicalQuota(row, dimension) {
  if (!row) {
    return Object.freeze({
      dimension,
      state: 'not_configured',
      softLimit: null,
      hardLimit: null,
      revision: 0,
    });
  }
  if (row.dimension !== dimension) invalid('PLATFORM_OPERATIONAL_QUOTA_PERSISTED_INVALID');
  const state = row.state;
  const softLimit = databaseValue(row.soft_limit, 'PLATFORM_OPERATIONAL_QUOTA_PERSISTED_INVALID');
  const hardLimit = databaseValue(row.hard_limit, 'PLATFORM_OPERATIONAL_QUOTA_PERSISTED_INVALID');
  requireQuotaState(state, softLimit, hardLimit);
  return Object.freeze({
    dimension,
    state,
    softLimit,
    hardLimit,
    revision: requireRevision(
      Number(row.revision),
      { allowZero: false },
    ),
  });
}

function receiptQuota(row) {
  const softLimit = databaseValue(
    row.result_soft_limit,
    'PLATFORM_OPERATIONAL_QUOTA_RECEIPT_INVALID',
  );
  const hardLimit = databaseValue(
    row.result_hard_limit,
    'PLATFORM_OPERATIONAL_QUOTA_RECEIPT_INVALID',
  );
  requireQuotaState(row.result_state, softLimit, hardLimit);
  return Object.freeze({
    state: row.result_state,
    softLimit,
    hardLimit,
    revision: requireRevision(Number(row.result_revision)),
  });
}

function quotaSnapshot(quota) {
  return Object.freeze({
    dimension: quota.dimension,
    state: quota.state,
    softLimit: quota.softLimit,
    hardLimit: quota.hardLimit,
    revision: quota.revision,
  });
}

async function lockPeriod(client, tenantId, periodStart) {
  await client.query({
    name: 'platform-metering-period-advisory-lock',
    text: `
      SELECT pg_advisory_xact_lock(
        hashtextextended($1::text || ':' || $2::text, 739141932118)
      )
    `,
    values: [tenantId, periodStart],
  });
}

async function lockQuota(client, tenantId, dimension) {
  await client.query({
    name: 'platform-operational-quota-advisory-lock',
    text: `
      SELECT pg_advisory_xact_lock(
        hashtextextended($1::text || ':' || $2::text, 739141932119)
      )
    `,
    values: [tenantId, dimension],
  });
}

async function loadQuotaRows(client, tenantId) {
  const result = await client.query({
    name: 'platform-operational-quotas-read',
    text: `
      SELECT dimension, state, soft_limit, hard_limit, revision
      FROM platform_operational_quotas
      WHERE tenant_id = $1
      ORDER BY dimension
    `,
    values: [tenantId],
  });
  const byDimension = new Map(result.rows.map((row) => [row.dimension, row]));
  if (byDimension.size !== result.rowCount) {
    invalid('PLATFORM_OPERATIONAL_QUOTA_PERSISTED_INVALID');
  }
  return Object.freeze(DIMENSION_ORDER.map((dimension) => {
    return logicalQuota(byDimension.get(dimension), dimension);
  }));
}

function validateEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('PLATFORM_METERING_EVENT_INVALID');
  }
  const tenantId = requireUuid(input.tenantId, 'PLATFORM_METERING_TENANT_ID_INVALID');
  const sourceEventKey = requireHash(
    input.sourceEventKey,
    'PLATFORM_METERING_SOURCE_EVENT_KEY_INVALID',
  );
  const payloadDigest = requireHash(
    input.payloadDigest,
    'PLATFORM_METERING_EVENT_PAYLOAD_DIGEST_INVALID',
  );
  const dimension = EVENT_DIMENSION[input.eventType];
  if (!dimension || input.dimension !== dimension || input.units !== 1) {
    invalid('PLATFORM_METERING_EVENT_INVALID');
  }
  const occurredAt = requireInstant(input.occurredAt, 'PLATFORM_METERING_EVENT_TIME_INVALID');
  const recordedAt = requireInstant(input.recordedAt, 'PLATFORM_METERING_EVENT_TIME_INVALID');
  const period = requirePeriod(input.periodStart, input.periodEnd);
  if (
    Date.parse(occurredAt) < Date.parse(period.start)
    || Date.parse(occurredAt) >= Date.parse(period.end)
    || Date.parse(recordedAt) < Date.parse(occurredAt)
  ) {
    invalid('PLATFORM_METERING_EVENT_TIME_INVALID');
  }
  return Object.freeze({
    tenantId,
    sourceEventKey,
    payloadDigest,
    eventType: input.eventType,
    dimension,
    occurredAt,
    recordedAt,
    period,
  });
}

function validateSnapshot(value, tenantId, reconciledAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('PLATFORM_METERING_RECONCILIATION_INVALID');
  }
  const period = requirePeriod(value.periodStart, value.periodEnd);
  if (!DATA_STATES.has(value.dataState)) invalid('PLATFORM_METERING_RECONCILIATION_INVALID');
  const values = requireValues(value.values);
  const measuredAt = value.measuredAt === null
    ? null
    : requireInstant(value.measuredAt, 'PLATFORM_METERING_RECONCILIATION_INVALID');
  const eventWatermark = value.eventWatermark === null
    ? null
    : requireInstant(value.eventWatermark, 'PLATFORM_METERING_RECONCILIATION_INVALID');
  const populated = Object.values(values).filter((entry) => entry !== null).length;
  if (
    (
      value.dataState === 'complete'
      && (populated !== DIMENSION_ORDER.length || measuredAt === null || eventWatermark === null)
    )
    || (
      value.dataState === 'partial'
      && (populated === 0 || measuredAt === null || eventWatermark === null)
    )
    || (
      value.dataState === 'unknown'
      && (populated !== 0 || measuredAt !== null || eventWatermark !== null)
    )
    || (
      measuredAt !== null
      && eventWatermark !== null
      && Date.parse(eventWatermark) > Date.parse(measuredAt)
    )
    || (measuredAt !== null && Date.parse(measuredAt) > Date.parse(reconciledAt))
  ) {
    invalid('PLATFORM_METERING_RECONCILIATION_INVALID');
  }
  return Object.freeze({
    tenantId,
    period,
    dataState: value.dataState,
    measuredAt,
    eventWatermark,
    values,
  });
}

function lateEventValues(row) {
  return Object.freeze({
    requests_created: databaseValue(row.requests_created),
    bookings_confirmed: databaseValue(row.bookings_confirmed),
    integration_operations: databaseValue(row.integration_operations),
  });
}

function addCounter(base, increment) {
  if (base === null && increment === 0) return null;
  const result = (base ?? 0) + increment;
  if (!Number.isSafeInteger(result) || result > MAX_SAFE_VALUE) {
    invalid('PLATFORM_METERING_VALUE_OVERFLOW');
  }
  return result;
}

function hasKnownValues(values) {
  return Object.values(values).some((value) => value !== null);
}

function maxInstant(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function reconcileProjection(snapshot, existing, late) {
  const existingValues = valuesFromRow(existing);
  const existingMeasuredAt = instant(existing?.measured_at);
  const lateValues = lateEventValues(late);
  const lateCount = Object.values(lateValues).reduce((sum, value) => sum + value, 0);
  const lateMeasuredAt = instant(late.latest_ingested_at);
  const existingEventWatermark = instant(existing?.event_watermark);

  if (snapshot.dataState === 'unknown') {
    if (existing && hasKnownValues(existingValues)) {
      return Object.freeze({
        dataState: 'partial',
        measuredAt: existingMeasuredAt,
        eventWatermark: existingEventWatermark,
        values: existingValues,
      });
    }
    if (lateCount > 0) {
      return Object.freeze({
        dataState: 'partial',
        measuredAt: lateMeasuredAt,
        eventWatermark: lateMeasuredAt,
        values: Object.freeze({
          active_users: null,
          active_rooms: null,
          requests_created: lateValues.requests_created || null,
          bookings_confirmed: lateValues.bookings_confirmed || null,
          integration_operations: lateValues.integration_operations || null,
        }),
      });
    }
    return Object.freeze({
      dataState: 'unknown',
      measuredAt: null,
      eventWatermark: null,
      values: snapshot.values,
    });
  }

  if (
    existingMeasuredAt !== null
    && Date.parse(snapshot.measuredAt) < Date.parse(existingMeasuredAt)
  ) {
    return Object.freeze({
      dataState: 'partial',
      measuredAt: existingMeasuredAt,
      eventWatermark: existingEventWatermark,
      values: existingValues,
    });
  }

  return Object.freeze({
    dataState: snapshot.dataState === 'complete' && lateCount === 0 ? 'complete' : 'partial',
    measuredAt: maxInstant(snapshot.measuredAt, lateMeasuredAt),
    eventWatermark: maxInstant(snapshot.eventWatermark, lateMeasuredAt),
    values: Object.freeze({
      active_users: snapshot.values.active_users,
      active_rooms: snapshot.values.active_rooms,
      requests_created: addCounter(
        snapshot.values.requests_created,
        lateValues.requests_created,
      ),
      bookings_confirmed: addCounter(
        snapshot.values.bookings_confirmed,
        lateValues.bookings_confirmed,
      ),
      integration_operations: addCounter(
        snapshot.values.integration_operations,
        lateValues.integration_operations,
      ),
    }),
  });
}

async function authorizeOperatorTarget(client, { operatorId, operatorSecurityVersion, tenantId }) {
  const result = await client.query({
    name: 'platform-operational-quota-authoritative-target',
    text: `
      SELECT 1
      FROM platform_operators operator
      WHERE operator.id = $1
        AND operator.status = 'active'
        AND operator.security_version = $2
        AND (
          operator.scope_mode = 'all'
          OR (
            operator.scope_mode = 'allowlist'
            AND EXISTS (
              SELECT 1
              FROM platform_operator_tenant_scopes scope
              WHERE scope.operator_id = operator.id
                AND scope.tenant_id = $3
            )
          )
        )
      LIMIT 1
    `,
    values: [operatorId, operatorSecurityVersion, tenantId],
  });
  if (result.rowCount !== 1) invalid('PLATFORM_OPERATIONAL_QUOTA_TARGET_DENIED');
}

export function createPostgresPlatformMeteringRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async recordEvent(input) {
      const event = validateEvent(input);
      return withPostgresTransaction(pool, async (client) => {
        await lockPeriod(client, event.tenantId, event.period.start);
        const inserted = await client.query({
          name: 'platform-metering-event-insert',
          text: `
            INSERT INTO platform_metering_events (
              tenant_id, source_event_key, payload_digest, event_type, dimension, units,
              occurred_at, recorded_at, period_start, period_end, retain_until
            )
            VALUES (
              $1, $2, $3, $4, $5, 1, $6, $7, $8, $9,
              platform_add_utc_months(
                GREATEST($7::timestamptz, $9::timestamptz, clock_timestamp()), 24
              ) + INTERVAL '1 second'
            )
            ON CONFLICT (tenant_id, source_event_key) DO NOTHING
            RETURNING ingested_at
          `,
          values: [
            event.tenantId,
            event.sourceEventKey,
            event.payloadDigest,
            event.eventType,
            event.dimension,
            event.occurredAt,
            event.recordedAt,
            event.period.start,
            event.period.end,
          ],
        });
        if (inserted.rowCount === 0) {
          const replay = await client.query({
            name: 'platform-metering-event-replay-read',
            text: `
              SELECT payload_digest
              FROM platform_metering_events
              WHERE tenant_id = $1 AND source_event_key = $2
              FOR SHARE
            `,
            values: [event.tenantId, event.sourceEventKey],
          });
          if (replay.rowCount !== 1) throw new Error('PLATFORM_METERING_REPLAY_READ_FAILED');
          return Object.freeze({
            status: replay.rows[0].payload_digest === event.payloadDigest
              ? 'duplicate'
              : 'conflict',
          });
        }

        const ingestedAt = instant(inserted.rows[0].ingested_at);
        const increments = Object.fromEntries(DIMENSION_ORDER.map((dimension) => {
          return [dimension, dimension === event.dimension ? 1 : null];
        }));
        await client.query({
          name: 'platform-metering-period-event-upsert',
          text: `
            INSERT INTO platform_metering_periods (
              tenant_id, period_start, period_end, data_state, measured_at,
              event_watermark, reconciled_at, active_users, active_rooms,
              requests_created, bookings_confirmed, integration_operations,
              revision, retain_until
            )
            VALUES (
              $1, $2, $3, 'partial', $4, $4, NULL, $5, $6, $7, $8, $9, 1,
              platform_add_utc_months(GREATEST($3::timestamptz, $4::timestamptz), 24)
            )
            ON CONFLICT (tenant_id, period_start) DO UPDATE SET
              data_state = 'partial',
              measured_at = GREATEST(platform_metering_periods.measured_at, EXCLUDED.measured_at),
              event_watermark = GREATEST(
                platform_metering_periods.event_watermark,
                EXCLUDED.event_watermark
              ),
              reconciled_at = platform_metering_periods.reconciled_at,
              active_users = CASE
                WHEN EXCLUDED.active_users IS NULL THEN platform_metering_periods.active_users
                ELSE COALESCE(platform_metering_periods.active_users, 0) + EXCLUDED.active_users
              END,
              active_rooms = CASE
                WHEN EXCLUDED.active_rooms IS NULL THEN platform_metering_periods.active_rooms
                ELSE COALESCE(platform_metering_periods.active_rooms, 0) + EXCLUDED.active_rooms
              END,
              requests_created = CASE
                WHEN EXCLUDED.requests_created IS NULL THEN platform_metering_periods.requests_created
                ELSE COALESCE(platform_metering_periods.requests_created, 0)
                  + EXCLUDED.requests_created
              END,
              bookings_confirmed = CASE
                WHEN EXCLUDED.bookings_confirmed IS NULL
                  THEN platform_metering_periods.bookings_confirmed
                ELSE COALESCE(platform_metering_periods.bookings_confirmed, 0)
                  + EXCLUDED.bookings_confirmed
              END,
              integration_operations = CASE
                WHEN EXCLUDED.integration_operations IS NULL
                  THEN platform_metering_periods.integration_operations
                ELSE COALESCE(platform_metering_periods.integration_operations, 0)
                  + EXCLUDED.integration_operations
              END,
              revision = platform_metering_periods.revision + 1,
              retain_until = GREATEST(
                platform_metering_periods.retain_until,
                EXCLUDED.retain_until
              )
          `,
          values: [
            event.tenantId,
            event.period.start,
            event.period.end,
            ingestedAt,
            increments.active_users,
            increments.active_rooms,
            increments.requests_created,
            increments.bookings_confirmed,
            increments.integration_operations,
          ],
        });
        return Object.freeze({ status: 'recorded' });
      });
    },

    async readPeriod({ tenantId: tenantIdValue, periodStart, auditEventFor } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'PLATFORM_METERING_TENANT_ID_INVALID');
      const period = periodForStart(periodStart);
      if (auditEventFor !== undefined && typeof auditEventFor !== 'function') {
        invalid('PLATFORM_METERING_AUDIT_EVENT_FACTORY_REQUIRED');
      }
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'platform-metering-period-read',
          text: `
            SELECT tenant_id, period_start, period_end, data_state, measured_at,
              reconciled_at, active_users, active_rooms, requests_created,
              bookings_confirmed, integration_operations
            FROM platform_metering_periods
            WHERE tenant_id = $1 AND period_start = $2
            LIMIT 1
          `,
          values: [tenantId, period.start],
        });
        const quotas = await loadQuotaRows(client, tenantId);
        const row = result.rows[0];
        let record;
        if (row) {
          if (row.tenant_id !== tenantId) invalid('PLATFORM_METERING_TENANT_SCOPE_MISMATCH');
          record = Object.freeze({
            tenantId,
            periodStart: instant(row.period_start),
            periodEnd: instant(row.period_end),
            dataState: row.data_state,
            measuredAt: instant(row.measured_at),
            reconciledAt: instant(row.reconciled_at),
            values: valuesFromRow(row),
            quotas,
          });
        } else {
          record = Object.freeze({
            tenantId,
            periodStart: period.start,
            periodEnd: period.end,
            dataState: 'unknown',
            measuredAt: null,
            reconciledAt: null,
            values: Object.freeze(Object.fromEntries(
              DIMENSION_ORDER.map((dimension) => [dimension, null]),
            )),
            quotas,
          });
        }
        if (auditEventFor) {
          const audit = await auditRepository.appendWithClient(client, auditEventFor(record), {
            expectedTargetTenantId: tenantId,
          });
          if (!audit) throw new Error('PLATFORM_METERING_AUDIT_APPEND_FAILED');
        }
        return record;
      }, { isolationLevel: 'REPEATABLE READ', readOnly: auditEventFor === undefined });
    },

    async reconcilePeriods({
      tenantId: tenantIdValue,
      periods,
      reconciledAt,
      auditEventFor,
    } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'PLATFORM_METERING_TENANT_ID_INVALID');
      const reconciliationTime = requireInstant(
        reconciledAt,
        'PLATFORM_METERING_RECONCILIATION_INVALID',
      );
      if (!Array.isArray(periods) || periods.length < 1 || periods.length > MAX_BATCH_PERIODS) {
        invalid('PLATFORM_METERING_RECONCILIATION_INVALID');
      }
      if (typeof auditEventFor !== 'function') {
        invalid('PLATFORM_METERING_AUDIT_EVENT_FACTORY_REQUIRED');
      }
      const snapshots = periods.map((period) => {
        return validateSnapshot(period, tenantId, reconciliationTime);
      }).sort((left, right) => left.period.start.localeCompare(right.period.start));
      if (new Set(snapshots.map((snapshot) => snapshot.period.start)).size !== snapshots.length) {
        invalid('PLATFORM_METERING_RECONCILIATION_INVALID');
      }

      return withPostgresTransaction(pool, async (client) => {
        const currentByPeriod = new Map();
        for (const snapshot of snapshots) {
          await lockPeriod(client, tenantId, snapshot.period.start);
          const current = await client.query({
            name: 'platform-metering-period-lock',
            text: `
              SELECT data_state, measured_at, reconciled_at, active_users, active_rooms,
                event_watermark, requests_created, bookings_confirmed,
                integration_operations, revision, retain_until
              FROM platform_metering_periods
              WHERE tenant_id = $1 AND period_start = $2
              FOR UPDATE
            `,
            values: [tenantId, snapshot.period.start],
          });
          const existing = current.rows[0] || null;
          currentByPeriod.set(snapshot.period.start, existing);
          if (existing && snapshot.eventWatermark !== null) {
            const persistedEventWatermark = instant(existing.event_watermark);
            const persistedMeasuredAt = instant(existing.measured_at);
            if (
              (
                persistedEventWatermark !== null
                && Date.parse(snapshot.eventWatermark) < Date.parse(persistedEventWatermark)
              )
              || (
                persistedMeasuredAt !== null
                && Date.parse(snapshot.measuredAt) < Date.parse(persistedMeasuredAt)
              )
            ) {
              return Object.freeze({
                status: 'watermark_conflict',
                periodStart: snapshot.period.start,
              });
            }
          }
        }

        for (const snapshot of snapshots) {
          const existing = currentByPeriod.get(snapshot.period.start);
          const lateEvents = await client.query({
            name: 'platform-metering-period-late-events',
            text: `
              SELECT
                COUNT(*) FILTER (WHERE dimension = 'requests_created') AS requests_created,
                COUNT(*) FILTER (WHERE dimension = 'bookings_confirmed') AS bookings_confirmed,
                COUNT(*) FILTER (
                  WHERE dimension = 'integration_operations'
                ) AS integration_operations,
                MAX(ingested_at) AS latest_ingested_at
              FROM platform_metering_events
              WHERE tenant_id = $1
                AND period_start = $2
                AND ($3::timestamptz IS NULL OR ingested_at > $3::timestamptz)
                AND ingested_at <= $4::timestamptz
            `,
            values: [
              tenantId,
              snapshot.period.start,
              snapshot.eventWatermark,
              reconciliationTime,
            ],
          });
          const next = reconcileProjection(snapshot, existing, lateEvents.rows[0]);
          if (!existing) {
            await client.query({
              name: 'platform-metering-period-reconcile-insert',
              text: `
                INSERT INTO platform_metering_periods (
                  tenant_id, period_start, period_end, data_state, measured_at,
                  event_watermark, reconciled_at, active_users, active_rooms,
                  requests_created, bookings_confirmed, integration_operations,
                  revision, retain_until
                )
                VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1,
                  platform_add_utc_months(
                    GREATEST($3::timestamptz, $5::timestamptz, $6::timestamptz,
                      $7::timestamptz),
                    24
                  )
                )
              `,
              values: [
                tenantId,
                snapshot.period.start,
                snapshot.period.end,
                next.dataState,
                next.measuredAt,
                next.eventWatermark,
                reconciliationTime,
                next.values.active_users,
                next.values.active_rooms,
                next.values.requests_created,
                next.values.bookings_confirmed,
                next.values.integration_operations,
              ],
            });
            continue;
          }
          await client.query({
            name: 'platform-metering-period-reconcile-update',
            text: `
              UPDATE platform_metering_periods
              SET data_state = $3,
                  measured_at = $4,
                  event_watermark = $5,
                  reconciled_at = $6,
                  active_users = $7,
                  active_rooms = $8,
                  requests_created = $9,
                  bookings_confirmed = $10,
                  integration_operations = $11,
                  revision = revision + 1,
                  retain_until = GREATEST(
                    retain_until,
                    platform_add_utc_months($6::timestamptz, 24)
                  )
              WHERE tenant_id = $1
                AND period_start = $2
                AND ROW(
                  data_state,
                  measured_at,
                  event_watermark,
                  active_users,
                  active_rooms,
                  requests_created,
                  bookings_confirmed,
                  integration_operations
                ) IS DISTINCT FROM ROW(
                  $3, $4::timestamptz, $5::timestamptz, $7, $8, $9, $10, $11
                )
            `,
            values: [
              tenantId,
              snapshot.period.start,
              next.dataState,
              next.measuredAt,
              next.eventWatermark,
              reconciliationTime,
              next.values.active_users,
              next.values.active_rooms,
              next.values.requests_created,
              next.values.bookings_confirmed,
              next.values.integration_operations,
            ],
          });
        }
        const audit = await auditRepository.appendWithClient(client, auditEventFor(), {
          expectedTargetTenantId: tenantId,
        });
        if (!audit) throw new Error('PLATFORM_METERING_AUDIT_APPEND_FAILED');
        return Object.freeze({ status: 'reconciled', periodCount: snapshots.length });
      });
    },

    async setOperationalQuota(input = {}) {
      const tenantId = requireUuid(input.tenantId, 'PLATFORM_METERING_TENANT_ID_INVALID');
      const operatorId = requireUuid(input.operatorId, 'PLATFORM_METERING_OPERATOR_ID_INVALID');
      const operatorSecurityVersion = requireRevision(input.operatorSecurityVersion);
      const dimension = requireDimension(input.dimension);
      const requested = requireQuotaState(input.state, input.softLimit, input.hardLimit);
      const expectedRevision = requireRevision(input.expectedRevision, { allowZero: true });
      const idempotencyKey = requireUuid(
        input.idempotencyKey,
        'PLATFORM_METERING_IDEMPOTENCY_KEY_INVALID',
      );
      const requestDigest = requireHash(
        input.requestDigest,
        'PLATFORM_METERING_REQUEST_DIGEST_INVALID',
      );
      if (typeof input.auditEventFor !== 'function') {
        invalid('PLATFORM_METERING_AUDIT_EVENT_FACTORY_REQUIRED');
      }

      return withPostgresTransaction(pool, async (client) => {
        await lockQuota(client, tenantId, dimension);
        await authorizeOperatorTarget(client, { operatorId, operatorSecurityVersion, tenantId });
        const replay = await client.query({
          name: 'platform-operational-quota-receipt-read',
          text: `
            SELECT request_digest, result_state, result_soft_limit,
              result_hard_limit, result_revision
            FROM platform_quota_operation_receipts
            WHERE tenant_id = $1 AND idempotency_key = $2
            FOR UPDATE
          `,
          values: [tenantId, idempotencyKey],
        });
        if (replay.rowCount === 1) {
          if (replay.rows[0].request_digest !== requestDigest) {
            return Object.freeze({ status: 'idempotency_conflict' });
          }
          return Object.freeze({ status: 'replay', quota: receiptQuota(replay.rows[0]) });
        }

        const currentResult = await client.query({
          name: 'platform-operational-quota-lock',
          text: `
            SELECT dimension, state, soft_limit, hard_limit, revision
            FROM platform_operational_quotas
            WHERE tenant_id = $1 AND dimension = $2
            FOR UPDATE
          `,
          values: [tenantId, dimension],
        });
        const previous = logicalQuota(currentResult.rows[0], dimension);
        if (previous.revision !== expectedRevision) {
          return Object.freeze({ status: 'conflict', currentRevision: previous.revision });
        }
        const next = Object.freeze({
          dimension,
          ...requested,
          revision: previous.revision + 1,
        });
        const auditEvent = input.auditEventFor({
          previousQuota: quotaSnapshot(previous),
          nextQuota: quotaSnapshot(next),
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent, {
          expectedTargetTenantId: tenantId,
        });
        if (!audit) throw new Error('PLATFORM_METERING_AUDIT_APPEND_FAILED');

        await client.query({
          name: 'platform-operational-quota-upsert',
          text: `
            INSERT INTO platform_operational_quotas (
              tenant_id, dimension, state, soft_limit, hard_limit, revision, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
            ON CONFLICT (tenant_id, dimension) DO UPDATE SET
              state = EXCLUDED.state,
              soft_limit = EXCLUDED.soft_limit,
              hard_limit = EXCLUDED.hard_limit,
              revision = EXCLUDED.revision,
              updated_at = clock_timestamp()
          `,
          values: [
            tenantId,
            dimension,
            next.state,
            next.softLimit,
            next.hardLimit,
            next.revision,
          ],
        });
        await client.query({
          name: 'platform-operational-quota-receipt-insert',
          text: `
            INSERT INTO platform_quota_operation_receipts (
              tenant_id, idempotency_key, operator_id, request_digest,
              dimension, result_state, result_soft_limit, result_hard_limit,
              result_revision, created_at, retain_until
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              clock_timestamp(),
              platform_add_utc_months(clock_timestamp(), 24) + INTERVAL '1 second'
            )
          `,
          values: [
            tenantId,
            idempotencyKey,
            operatorId,
            requestDigest,
            dimension,
            next.state,
            next.softLimit,
            next.hardLimit,
            next.revision,
          ],
        });
        return Object.freeze({
          status: 'updated',
          quota: Object.freeze({
            state: next.state,
            softLimit: next.softLimit,
            hardLimit: next.hardLimit,
            revision: next.revision,
          }),
        });
      });
    },
  });
}

export function createPostgresPlatformUsageSource(
  pool,
  { counterProducersReady } = {},
) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (typeof counterProducersReady !== 'boolean') {
    throw new TypeError('PLATFORM_METERING_COUNTER_PRODUCER_READINESS_REQUIRED');
  }

  return Object.freeze({
    async readPeriod({ tenantId: tenantIdValue, periodStart, periodEnd } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'PLATFORM_METERING_TENANT_ID_INVALID');
      const period = requirePeriod(periodStart, periodEnd);
      return withPostgresTransaction(pool, async (client) => {
        await lockPeriod(client, tenantId, period.start);
        const result = await client.query({
          name: 'platform-metering-authoritative-source-read',
          text: `
            WITH observation AS (
              SELECT date_trunc('milliseconds', clock_timestamp()) AS observed_at
            )
            SELECT
              observation.observed_at,
              EXISTS (SELECT 1 FROM tenants WHERE id = $1) AS tenant_exists,
              CASE
                WHEN observation.observed_at >= $2::timestamptz
                 AND observation.observed_at < $3::timestamptz
                THEN (SELECT COUNT(*) FROM users WHERE tenant_id = $1 AND active = TRUE)
                ELSE NULL
              END AS active_users,
              CASE
                WHEN observation.observed_at >= $2::timestamptz
                 AND observation.observed_at < $3::timestamptz
                THEN (SELECT COUNT(*) FROM rooms WHERE tenant_id = $1 AND active = TRUE)
                ELSE NULL
              END AS active_rooms,
              COUNT(*) FILTER (WHERE event.dimension = 'requests_created')
                AS requests_created,
              COUNT(*) FILTER (WHERE event.dimension = 'bookings_confirmed')
                AS bookings_confirmed,
              COUNT(*) FILTER (WHERE event.dimension = 'integration_operations')
                AS integration_operations
            FROM observation
            LEFT JOIN platform_metering_events event
              ON event.tenant_id = $1
             AND event.period_start = $2
            GROUP BY observation.observed_at
          `,
          values: [tenantId, period.start, period.end],
        });
        const row = result.rows[0];
        if (!row?.tenant_exists) invalid('PLATFORM_METERING_TENANT_NOT_FOUND');
        const measuredAt = instant(row.observed_at);
        if (Date.parse(period.start) > Date.parse(measuredAt)) {
          return Object.freeze({
            dataState: 'unknown',
            measuredAt: null,
            eventWatermark: null,
            values: Object.freeze(Object.fromEntries(
              DIMENSION_ORDER.map((dimension) => [dimension, null]),
            )),
          });
        }
        const values = Object.freeze({
          active_users: databaseValue(row.active_users),
          active_rooms: databaseValue(row.active_rooms),
          requests_created: databaseValue(row.requests_created),
          bookings_confirmed: databaseValue(row.bookings_confirmed),
          integration_operations: databaseValue(row.integration_operations),
        });
        const complete = counterProducersReady
          && values.active_users !== null
          && values.active_rooms !== null;
        return Object.freeze({
          dataState: complete ? 'complete' : 'partial',
          measuredAt,
          eventWatermark: measuredAt,
          values,
        });
      });
    },
  });
}
