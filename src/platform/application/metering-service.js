import { createHash } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_AUDIT_ACTION, PLATFORM_AUDIT_RETENTION } from '../audit/event.js';
import { PlatformAuthorizationError } from '../identity/errors.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import {
  PlatformOperationConflictError,
  PlatformOperationDeniedError,
} from './platform-operation-errors.js';

export const PLATFORM_USAGE_DIMENSION = Object.freeze({
  ACTIVE_USERS: 'active_users',
  ACTIVE_ROOMS: 'active_rooms',
  REQUESTS_CREATED: 'requests_created',
  BOOKINGS_CONFIRMED: 'bookings_confirmed',
  INTEGRATION_OPERATIONS: 'integration_operations',
});

export const PLATFORM_USAGE_EVENT = Object.freeze({
  REQUEST_CREATED: 'request.created',
  BOOKING_CONFIRMED: 'booking.confirmed',
  INTEGRATION_OPERATION_COMPLETED: 'integration.operation.completed',
});

export const METERING_DATA_STATE = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
});

export const OPERATIONAL_QUOTA_POLICY_STATE = Object.freeze({
  CONFIGURED: 'configured',
  NOT_CONFIGURED: 'not_configured',
  UNKNOWN: 'unknown',
});

export const OPERATIONAL_QUOTA_DECISION = Object.freeze({
  WITHIN: 'within',
  SOFT_EXCEEDED: 'soft_exceeded',
  HARD_EXCEEDED: 'hard_exceeded',
  NOT_CONFIGURED: 'not_configured',
  UNKNOWN: 'unknown',
});

export const PLATFORM_QUOTA_CONFIRMATION_ACTION = 'tenant.quota.set';

const DIMENSION_ORDER = Object.freeze(Object.values(PLATFORM_USAGE_DIMENSION));
const DIMENSIONS = new Set(DIMENSION_ORDER);
const DATA_STATES = new Set(Object.values(METERING_DATA_STATE));
const QUOTA_POLICY_STATES = new Set(Object.values(OPERATIONAL_QUOTA_POLICY_STATE));
const EVENT_DIMENSION = Object.freeze({
  [PLATFORM_USAGE_EVENT.REQUEST_CREATED]: PLATFORM_USAGE_DIMENSION.REQUESTS_CREATED,
  [PLATFORM_USAGE_EVENT.BOOKING_CONFIRMED]: PLATFORM_USAGE_DIMENSION.BOOKINGS_CONFIRMED,
  [PLATFORM_USAGE_EVENT.INTEGRATION_OPERATION_COMPLETED]:
    PLATFORM_USAGE_DIMENSION.INTEGRATION_OPERATIONS,
});
const MAX_BACKFILL_PERIODS = 24;
const MAX_REQUESTED_UNITS = 1_000_000;
const MAX_QUOTA_LIMIT = Number.MAX_SAFE_INTEGER;
const MAX_REASON_LENGTH = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function invalid(code) {
  throw new TypeError(code);
}

function exactRecord(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code);
  }
  return value;
}

function requireTenantId(value) {
  if (!isInternalUuid(value)) invalid('PLATFORM_METERING_TENANT_ID_INVALID');
  return value;
}

function requireCanonicalInstant(value, code) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (
    !Number.isFinite(milliseconds)
    || !value.endsWith('Z')
    || new Date(milliseconds).toISOString() !== value
  ) {
    invalid(code);
  }
  return value;
}

function clockInstant(clock) {
  const milliseconds = clock();
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || !Number.isFinite(new Date(milliseconds).getTime())
  ) {
    invalid('PLATFORM_METERING_CLOCK_INVALID');
  }
  return Object.freeze({ milliseconds, instant: new Date(milliseconds).toISOString() });
}

function periodAt(milliseconds) {
  const startDate = new Date(milliseconds);
  startDate.setUTCDate(1);
  startDate.setUTCHours(0, 0, 0, 0);
  const endDate = new Date(startDate);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  return Object.freeze({
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    timeZone: 'UTC',
  });
}

function requirePeriodStart(value) {
  const start = requireCanonicalInstant(value, 'PLATFORM_METERING_PERIOD_INVALID');
  const period = periodAt(Date.parse(start));
  if (period.start !== start) invalid('PLATFORM_METERING_PERIOD_INVALID');
  return period;
}

function periodsBetween(fromPeriodStart, toPeriodStart) {
  const first = requirePeriodStart(fromPeriodStart);
  const last = requirePeriodStart(toPeriodStart);
  if (Date.parse(first.start) > Date.parse(last.start)) {
    invalid('PLATFORM_METERING_BACKFILL_RANGE_INVALID');
  }
  const periods = [];
  let current = first;
  while (Date.parse(current.start) <= Date.parse(last.start)) {
    periods.push(current);
    if (periods.length > MAX_BACKFILL_PERIODS) {
      invalid('PLATFORM_METERING_BACKFILL_RANGE_INVALID');
    }
    current = periodAt(Date.parse(current.end));
  }
  return Object.freeze(periods);
}

function requireUsageValue(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    invalid('PLATFORM_METERING_USAGE_VALUE_INVALID');
  }
  return value;
}

function normalizeValues(value) {
  exactRecord(value, DIMENSION_ORDER, 'PLATFORM_METERING_VALUES_INVALID');
  return Object.freeze(Object.fromEntries(DIMENSION_ORDER.map((dimension) => {
    return [dimension, requireUsageValue(value[dimension])];
  })));
}

function normalizeDataState(value, values, measuredAt) {
  if (!DATA_STATES.has(value)) invalid('PLATFORM_METERING_DATA_STATE_INVALID');
  const populated = Object.values(values).filter((entry) => entry !== null).length;
  if (value === METERING_DATA_STATE.COMPLETE && populated !== DIMENSION_ORDER.length) {
    invalid('PLATFORM_METERING_DATA_STATE_INVALID');
  }
  if (value === METERING_DATA_STATE.UNKNOWN && populated !== 0) {
    invalid('PLATFORM_METERING_DATA_STATE_INVALID');
  }
  if (value === METERING_DATA_STATE.UNKNOWN && measuredAt !== null) {
    invalid('PLATFORM_METERING_MEASURED_AT_INVALID');
  }
  if (value !== METERING_DATA_STATE.UNKNOWN && measuredAt === null) {
    invalid('PLATFORM_METERING_MEASURED_AT_INVALID');
  }
  return value;
}

function optionalInstant(value, code) {
  return value === null ? null : requireCanonicalInstant(value, code);
}

function normalizeQuota(value) {
  exactRecord(
    value,
    ['dimension', 'state', 'softLimit', 'hardLimit', 'revision'],
    'PLATFORM_METERING_QUOTA_INVALID',
  );
  if (!DIMENSIONS.has(value.dimension) || !QUOTA_POLICY_STATES.has(value.state)) {
    invalid('PLATFORM_METERING_QUOTA_INVALID');
  }
  const softLimit = requireUsageValue(value.softLimit);
  const hardLimit = requireUsageValue(value.hardLimit);
  if (value.state === OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED) {
    if (softLimit === null && hardLimit === null) invalid('PLATFORM_METERING_QUOTA_INVALID');
    if (softLimit !== null && hardLimit !== null && softLimit > hardLimit) {
      invalid('PLATFORM_METERING_QUOTA_INVALID');
    }
  } else if (softLimit !== null || hardLimit !== null) {
    invalid('PLATFORM_METERING_QUOTA_INVALID');
  }
  const revision = value.revision;
  if (
    (value.state === OPERATIONAL_QUOTA_POLICY_STATE.UNKNOWN && revision !== null)
    || (
      value.state !== OPERATIONAL_QUOTA_POLICY_STATE.UNKNOWN
      && (!Number.isSafeInteger(revision) || revision < 0)
    )
    || (value.state === OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED && revision < 1)
  ) {
    invalid('PLATFORM_METERING_QUOTA_INVALID');
  }
  return Object.freeze({
    dimension: value.dimension,
    state: value.state,
    softLimit,
    hardLimit,
    revision,
  });
}

function normalizeQuotas(value) {
  if (!Array.isArray(value) || value.length !== DIMENSION_ORDER.length) {
    invalid('PLATFORM_METERING_QUOTAS_INVALID');
  }
  const byDimension = new Map();
  for (const candidate of value) {
    const quota = normalizeQuota(candidate);
    if (byDimension.has(quota.dimension)) invalid('PLATFORM_METERING_QUOTAS_INVALID');
    byDimension.set(quota.dimension, quota);
  }
  if (DIMENSION_ORDER.some((dimension) => !byDimension.has(dimension))) {
    invalid('PLATFORM_METERING_QUOTAS_INVALID');
  }
  return Object.freeze(DIMENSION_ORDER.map((dimension) => byDimension.get(dimension)));
}

function normalizePeriodRecord(value, tenantId, period) {
  exactRecord(value, [
    'tenantId',
    'periodStart',
    'periodEnd',
    'dataState',
    'measuredAt',
    'reconciledAt',
    'values',
    'quotas',
  ], 'PLATFORM_METERING_PERIOD_RECORD_INVALID');
  if (
    value.tenantId !== tenantId
    || value.periodStart !== period.start
    || value.periodEnd !== period.end
  ) {
    invalid('PLATFORM_METERING_PERIOD_SCOPE_MISMATCH');
  }
  const values = normalizeValues(value.values);
  const measuredAt = optionalInstant(value.measuredAt, 'PLATFORM_METERING_MEASURED_AT_INVALID');
  const dataState = normalizeDataState(value.dataState, values, measuredAt);
  const reconciledAt = optionalInstant(
    value.reconciledAt,
    'PLATFORM_METERING_RECONCILED_AT_INVALID',
  );
  if (
    measuredAt !== null
    && reconciledAt !== null
    && Date.parse(measuredAt) > Date.parse(reconciledAt)
  ) {
    invalid('PLATFORM_METERING_RECONCILED_AT_INVALID');
  }
  return Object.freeze({
    tenantId,
    period,
    dataState,
    measuredAt,
    reconciledAt,
    values,
    quotas: normalizeQuotas(value.quotas),
  });
}

function periodProjection(record) {
  return Object.freeze({
    schemaVersion: 1,
    tenantId: record.tenantId,
    period: record.period,
    dataState: record.dataState,
    measuredAt: record.measuredAt,
    reconciledAt: record.reconciledAt,
    dimensions: Object.freeze(DIMENSION_ORDER.map((dimension) => Object.freeze({
      dimension,
      value: record.values[dimension],
    }))),
    quotas: record.quotas,
  });
}

function sourceSnapshot(value, reconciledAt) {
  exactRecord(
    value,
    ['dataState', 'measuredAt', 'eventWatermark', 'values'],
    'PLATFORM_METERING_SOURCE_SNAPSHOT_INVALID',
  );
  const values = normalizeValues(value.values);
  const measuredAt = optionalInstant(value.measuredAt, 'PLATFORM_METERING_MEASURED_AT_INVALID');
  const eventWatermark = optionalInstant(
    value.eventWatermark,
    'PLATFORM_METERING_EVENT_WATERMARK_INVALID',
  );
  const dataState = normalizeDataState(value.dataState, values, measuredAt);
  if (
    (dataState === METERING_DATA_STATE.UNKNOWN && eventWatermark !== null)
    || (dataState !== METERING_DATA_STATE.UNKNOWN && eventWatermark === null)
    || (
      measuredAt !== null
      && eventWatermark !== null
      && Date.parse(eventWatermark) > Date.parse(measuredAt)
    )
    || (measuredAt !== null && Date.parse(measuredAt) > Date.parse(reconciledAt))
  ) {
    invalid('PLATFORM_METERING_EVENT_WATERMARK_INVALID');
  }
  return Object.freeze({ dataState, measuredAt, eventWatermark, values });
}

function requireDimension(value) {
  if (!DIMENSIONS.has(value)) invalid('PLATFORM_METERING_DIMENSION_INVALID');
  return value;
}

function requireQuotaLimit(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUOTA_LIMIT) {
    invalid('PLATFORM_METERING_QUOTA_LIMIT_INVALID');
  }
  return value;
}

function requireExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('PLATFORM_METERING_QUOTA_REVISION_INVALID');
  }
  return value;
}

function requireReason(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_REASON_LENGTH
    || value.trim() !== value
    || CONTROL_CHARACTERS.test(value)
  ) {
    invalid('PLATFORM_METERING_QUOTA_REASON_INVALID');
  }
  return value;
}

function requireQuotaConfirmation(value, tenantId, dimension) {
  exactRecord(
    value,
    ['action', 'tenantId', 'dimension'],
    'PLATFORM_METERING_QUOTA_CONFIRMATION_INVALID',
  );
  if (
    value.action !== PLATFORM_QUOTA_CONFIRMATION_ACTION
    || value.tenantId !== tenantId
    || value.dimension !== dimension
  ) {
    invalid('PLATFORM_METERING_QUOTA_CONFIRMATION_INVALID');
  }
  return Object.freeze({
    action: PLATFORM_QUOTA_CONFIRMATION_ACTION,
    tenantId,
    dimension,
  });
}

function requireInternalId(value, code) {
  if (!isInternalUuid(value)) invalid(code);
  return value;
}

function normalizeQuotaChange(value) {
  exactRecord(
    value,
    ['state', 'softLimit', 'hardLimit'],
    'PLATFORM_METERING_QUOTA_CHANGE_INVALID',
  );
  if (
    value.state !== OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED
    && value.state !== OPERATIONAL_QUOTA_POLICY_STATE.NOT_CONFIGURED
  ) {
    invalid('PLATFORM_METERING_QUOTA_CHANGE_INVALID');
  }
  const softLimit = requireQuotaLimit(value.softLimit);
  const hardLimit = requireQuotaLimit(value.hardLimit);
  if (
    value.state === OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED
    && softLimit === null
    && hardLimit === null
  ) {
    invalid('PLATFORM_METERING_QUOTA_CHANGE_INVALID');
  }
  if (
    value.state === OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED
    && softLimit !== null
    && hardLimit !== null
    && softLimit > hardLimit
  ) {
    invalid('PLATFORM_METERING_QUOTA_CHANGE_INVALID');
  }
  if (
    value.state === OPERATIONAL_QUOTA_POLICY_STATE.NOT_CONFIGURED
    && (softLimit !== null || hardLimit !== null)
  ) {
    invalid('PLATFORM_METERING_QUOTA_CHANGE_INVALID');
  }
  return Object.freeze({ state: value.state, softLimit, hardLimit });
}

function quotaRequestDigest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function createPlatformUsageEventSourceAuthority() {
  const sourceContext = Object.freeze({ source: 'platform_usage_event_authority' });
  return Object.freeze({
    policy: Object.freeze({
      authorize(candidate) {
        return candidate === sourceContext;
      },
    }),
    bindRecorder(meteringService) {
      if (!meteringService || typeof meteringService.recordUsageEvent !== 'function') {
        invalid('PLATFORM_METERING_SERVICE_REQUIRED');
      }
      function record(eventType, input) {
        exactRecord(
          input,
          ['tenantId', 'sourceEventId', 'occurredAt'],
          'PLATFORM_METERING_EVENT_INPUT_INVALID',
        );
        return meteringService.recordUsageEvent({ sourceContext, eventType, ...input });
      }
      return Object.freeze({
        recordRequestCreated(input) {
          return record(PLATFORM_USAGE_EVENT.REQUEST_CREATED, input);
        },
        recordBookingConfirmed(input) {
          return record(PLATFORM_USAGE_EVENT.BOOKING_CONFIRMED, input);
        },
        recordIntegrationOperationCompleted(input) {
          return record(PLATFORM_USAGE_EVENT.INTEGRATION_OPERATION_COMPLETED, input);
        },
      });
    },
  });
}

function sourceEventKey(tenantId, sourceEventId) {
  return createHash('sha256')
    .update(`${tenantId}\u0000${sourceEventId}`)
    .digest('hex');
}

function eventPayloadDigest({ eventType, dimension, occurredAt }) {
  return createHash('sha256')
    .update(JSON.stringify({ eventType, dimension, occurredAt, units: 1 }), 'utf8')
    .digest('hex');
}

function validateRuntime({
  repository,
  usageSource,
  authorizationPolicy,
  tenantTargetPolicy,
  auditService,
  usageEventSourcePolicy,
  clock,
}) {
  if (
    !repository
    || typeof repository.recordEvent !== 'function'
    || typeof repository.readPeriod !== 'function'
    || typeof repository.reconcilePeriods !== 'function'
    || typeof repository.setOperationalQuota !== 'function'
  ) {
    invalid('PLATFORM_METERING_REPOSITORY_REQUIRED');
  }
  if (!usageSource || typeof usageSource.readPeriod !== 'function') {
    invalid('PLATFORM_METERING_USAGE_SOURCE_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.authorize !== 'function') {
    invalid('PLATFORM_METERING_AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!tenantTargetPolicy || typeof tenantTargetPolicy.authorize !== 'function') {
    invalid('PLATFORM_METERING_TENANT_TARGET_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createEvent !== 'function') {
    invalid('PLATFORM_METERING_AUDIT_SERVICE_REQUIRED');
  }
  if (!usageEventSourcePolicy || typeof usageEventSourcePolicy.authorize !== 'function') {
    invalid('PLATFORM_METERING_EVENT_SOURCE_POLICY_REQUIRED');
  }
  if (typeof clock !== 'function') invalid('PLATFORM_METERING_CLOCK_REQUIRED');
}

async function authorizeTarget({
  authorizationPolicy,
  tenantTargetPolicy,
  operatorContext,
  tenantId,
  permission,
}) {
  let permissionDecision;
  try {
    permissionDecision = await authorizationPolicy.authorize(operatorContext, permission);
  } catch (error) {
    if (error instanceof PlatformAuthorizationError) {
      throw new PlatformOperationDeniedError(error.code);
    }
    throw error;
  }
  if (permissionDecision !== true) throw new PlatformOperationDeniedError();
  let targetDecision;
  try {
    targetDecision = await tenantTargetPolicy.authorize(operatorContext, tenantId);
  } catch (error) {
    if (error instanceof PlatformAuthorizationError) {
      throw new PlatformOperationDeniedError(error.code);
    }
    throw error;
  }
  if (targetDecision !== true) throw new PlatformOperationDeniedError();
}

export function createPlatformMeteringService({
  repository,
  usageSource,
  authorizationPolicy,
  tenantTargetPolicy,
  auditService,
  usageEventSourcePolicy,
  clock = () => Date.now(),
} = {}) {
  validateRuntime({
    repository,
    usageSource,
    authorizationPolicy,
    tenantTargetPolicy,
    auditService,
    usageEventSourcePolicy,
    clock,
  });

  async function reconcile({ operatorContext, tenantId, periods }) {
    await authorizeTarget({
      authorizationPolicy,
      tenantTargetPolicy,
      operatorContext,
      tenantId,
      permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    });
    const at = clockInstant(clock);
    const snapshots = [];
    for (const period of periods) {
      const snapshot = sourceSnapshot(await usageSource.readPeriod({
        tenantId,
        periodStart: period.start,
        periodEnd: period.end,
      }), at.instant);
      snapshots.push(Object.freeze({
        periodStart: period.start,
        periodEnd: period.end,
        ...snapshot,
      }));
    }
    const receipt = await repository.reconcilePeriods({
      tenantId,
      periods: snapshots,
      reconciledAt: at.instant,
      auditEventFor: () => auditService.createEvent({
        principal: operatorContext,
        action: PLATFORM_AUDIT_ACTION.RECOVERY_EXECUTED,
        targetType: 'tenant_metering',
        targetId: 'usage_periods',
        targetTenantId: tenantId,
        newState: Object.freeze({
          periodCount: snapshots.length,
          firstPeriodStart: snapshots[0].periodStart,
          lastPeriodStart: snapshots.at(-1).periodStart,
        }),
        metadata: Object.freeze({ operation: 'metering_reconciliation' }),
        retentionClass: PLATFORM_AUDIT_RETENTION.RECOVERY,
      }),
    });
    if (receipt?.status === 'watermark_conflict') {
      exactRecord(
        receipt,
        ['status', 'periodStart'],
        'PLATFORM_METERING_RECONCILIATION_FAILED',
      );
      requirePeriodStart(receipt.periodStart);
      throw new PlatformOperationConflictError(
        'PLATFORM_METERING_RECONCILIATION_WATERMARK_CONFLICT',
      );
    }
    exactRecord(receipt, ['status', 'periodCount'], 'PLATFORM_METERING_RECONCILIATION_FAILED');
    if (receipt.status !== 'reconciled' || receipt.periodCount !== snapshots.length) {
      invalid('PLATFORM_METERING_RECONCILIATION_FAILED');
    }
    return Object.freeze({
      schemaVersion: 1,
      tenantId,
      reconciledAt: at.instant,
      periods: Object.freeze(snapshots.map((snapshot) => Object.freeze({
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
        dataState: snapshot.dataState,
        measuredAt: snapshot.measuredAt,
        eventWatermark: snapshot.eventWatermark,
      }))),
    });
  }

  return Object.freeze({
    async recordUsageEvent(input) {
      exactRecord(
        input,
        ['sourceContext', 'tenantId', 'sourceEventId', 'eventType', 'occurredAt'],
        'PLATFORM_METERING_EVENT_INPUT_INVALID',
      );
      const tenantId = requireTenantId(input.tenantId);
      if (!isInternalUuid(input.sourceEventId)) {
        invalid('PLATFORM_METERING_SOURCE_EVENT_ID_INVALID');
      }
      const dimension = EVENT_DIMENSION[input.eventType];
      if (!dimension) invalid('PLATFORM_METERING_EVENT_TYPE_INVALID');
      const sourceDecision = await usageEventSourcePolicy.authorize(input.sourceContext, {
        tenantId,
        eventType: input.eventType,
      });
      if (sourceDecision !== true) invalid('PLATFORM_METERING_EVENT_SOURCE_DENIED');
      const occurredAt = requireCanonicalInstant(
        input.occurredAt,
        'PLATFORM_METERING_EVENT_TIME_INVALID',
      );
      const recorded = clockInstant(clock);
      if (Date.parse(occurredAt) > recorded.milliseconds) {
        invalid('PLATFORM_METERING_EVENT_TIME_INVALID');
      }
      const period = periodAt(Date.parse(occurredAt));
      const receipt = await repository.recordEvent({
        tenantId,
        sourceEventKey: sourceEventKey(tenantId, input.sourceEventId),
        payloadDigest: eventPayloadDigest({
          eventType: input.eventType,
          dimension,
          occurredAt,
        }),
        eventType: input.eventType,
        dimension,
        units: 1,
        occurredAt,
        recordedAt: recorded.instant,
        periodStart: period.start,
        periodEnd: period.end,
      });
      exactRecord(receipt, ['status'], 'PLATFORM_METERING_EVENT_RECEIPT_INVALID');
      if (receipt.status === 'conflict') {
        throw new PlatformOperationConflictError('PLATFORM_METERING_EVENT_REPLAY_CONFLICT');
      }
      if (receipt.status !== 'recorded' && receipt.status !== 'duplicate') {
        invalid('PLATFORM_METERING_EVENT_RECEIPT_INVALID');
      }
      return Object.freeze({
        status: receipt.status,
        tenantId,
        eventType: input.eventType,
        dimension,
        periodStart: period.start,
      });
    },

    async getUsagePeriod(input) {
      exactRecord(
        input,
        ['operatorContext', 'tenantId', 'periodStart'],
        'PLATFORM_METERING_READ_INPUT_INVALID',
      );
      const tenantId = requireTenantId(input.tenantId);
      const period = requirePeriodStart(input.periodStart);
      await authorizeTarget({
        authorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        tenantId,
        permission: PLATFORM_PERMISSION.METERING_READ,
      });
      const record = normalizePeriodRecord(
        await repository.readPeriod({
          tenantId,
          periodStart: period.start,
          auditEventFor: () => auditService.createEvent({
            principal: input.operatorContext,
            action: PLATFORM_AUDIT_ACTION.METERING_READ,
            targetType: 'tenant_metering_period',
            targetId: period.start,
            targetTenantId: tenantId,
            metadata: Object.freeze({ dataCategory: 'operational_aggregate' }),
            retentionClass: PLATFORM_AUDIT_RETENTION.ADMINISTRATIVE,
          }),
        }),
        tenantId,
        period,
      );
      return periodProjection(record);
    },

    async evaluateOperationalQuota(input) {
      exactRecord(
        input,
        ['tenantId', 'dimension', 'requestedUnits'],
        'PLATFORM_METERING_QUOTA_INPUT_INVALID',
      );
      const tenantId = requireTenantId(input.tenantId);
      const dimension = requireDimension(input.dimension);
      if (
        !Number.isSafeInteger(input.requestedUnits)
        || input.requestedUnits < 1
        || input.requestedUnits > MAX_REQUESTED_UNITS
      ) {
        invalid('PLATFORM_METERING_REQUESTED_UNITS_INVALID');
      }
      const current = clockInstant(clock);
      const period = periodAt(current.milliseconds);
      const record = normalizePeriodRecord(
        await repository.readPeriod({ tenantId, periodStart: period.start }),
        tenantId,
        period,
      );
      const quota = record.quotas.find((candidate) => candidate.dimension === dimension);
      const value = record.values[dimension];
      let state = OPERATIONAL_QUOTA_DECISION.UNKNOWN;
      let restrictsAdditionalUsage = null;
      let projectedValue = null;
      if (quota.state === OPERATIONAL_QUOTA_POLICY_STATE.NOT_CONFIGURED) {
        state = OPERATIONAL_QUOTA_DECISION.NOT_CONFIGURED;
        restrictsAdditionalUsage = false;
      } else if (
        quota.state === OPERATIONAL_QUOTA_POLICY_STATE.CONFIGURED
        && record.dataState === METERING_DATA_STATE.COMPLETE
        && value !== null
        && Number.isSafeInteger(value + input.requestedUnits)
      ) {
        projectedValue = value + input.requestedUnits;
        if (quota.hardLimit !== null && projectedValue > quota.hardLimit) {
          state = OPERATIONAL_QUOTA_DECISION.HARD_EXCEEDED;
          restrictsAdditionalUsage = true;
        } else if (quota.softLimit !== null && projectedValue > quota.softLimit) {
          state = OPERATIONAL_QUOTA_DECISION.SOFT_EXCEEDED;
          restrictsAdditionalUsage = false;
        } else {
          state = OPERATIONAL_QUOTA_DECISION.WITHIN;
          restrictsAdditionalUsage = false;
        }
      }
      return Object.freeze({
        schemaVersion: 1,
        tenantId,
        period,
        dimension,
        dataState: record.dataState,
        currentValue: value,
        requestedUnits: input.requestedUnits,
        projectedValue,
        quota,
        state,
        restrictsAdditionalUsage,
      });
    },

    async setOperationalQuota(input) {
      exactRecord(input, [
        'operatorContext',
        'tenantId',
        'dimension',
        'state',
        'softLimit',
        'hardLimit',
        'expectedRevision',
        'reason',
        'confirmation',
        'correlationId',
        'idempotencyKey',
      ], 'PLATFORM_METERING_QUOTA_SET_INPUT_INVALID');
      const tenantId = requireTenantId(input.tenantId);
      const dimension = requireDimension(input.dimension);
      const change = normalizeQuotaChange({
        state: input.state,
        softLimit: input.softLimit,
        hardLimit: input.hardLimit,
      });
      const expectedRevision = requireExpectedRevision(input.expectedRevision);
      const reason = requireReason(input.reason);
      const confirmation = requireQuotaConfirmation(input.confirmation, tenantId, dimension);
      const correlationId = requireInternalId(
        input.correlationId,
        'PLATFORM_METERING_CORRELATION_ID_INVALID',
      );
      const operationId = requireInternalId(
        input.idempotencyKey,
        'PLATFORM_METERING_IDEMPOTENCY_KEY_INVALID',
      );
      const operatorId = requireInternalId(
        input.operatorContext?.operatorId,
        'PLATFORM_METERING_OPERATOR_ID_INVALID',
      );
      const operatorSecurityVersion = input.operatorContext?.securityVersion;
      if (!Number.isSafeInteger(operatorSecurityVersion) || operatorSecurityVersion < 1) {
        invalid('PLATFORM_METERING_OPERATOR_SECURITY_VERSION_INVALID');
      }
      await authorizeTarget({
        authorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        tenantId,
        permission: PLATFORM_PERMISSION.QUOTA_MANAGE,
      });
      const requestDigest = quotaRequestDigest({
        operation: PLATFORM_QUOTA_CONFIRMATION_ACTION,
        tenantId,
        dimension,
        ...change,
        expectedRevision,
        reason,
      });
      const receipt = await repository.setOperationalQuota({
        tenantId,
        operatorId,
        operatorSecurityVersion,
        dimension,
        ...change,
        expectedRevision,
        idempotencyKey: operationId,
        requestDigest,
        auditEventFor: ({ previousQuota, nextQuota }) => auditService.createEvent({
          principal: input.operatorContext,
          action: PLATFORM_AUDIT_ACTION.TENANT_QUOTA_CHANGED,
          targetType: 'tenant_quota',
          targetId: dimension,
          targetTenantId: tenantId,
          previousState: previousQuota,
          newState: nextQuota,
          correlationId,
          metadata: Object.freeze({
            reason,
            confirmationAction: confirmation.action,
          }),
          retentionClass: PLATFORM_AUDIT_RETENTION.ADMINISTRATIVE,
        }),
      });
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        invalid('PLATFORM_METERING_QUOTA_RECEIPT_INVALID');
      }
      if (receipt.status === 'conflict') {
        exactRecord(
          receipt,
          ['status', 'currentRevision'],
          'PLATFORM_METERING_QUOTA_RECEIPT_INVALID',
        );
        throw new PlatformOperationConflictError('PLATFORM_METERING_QUOTA_REVISION_CONFLICT');
      }
      if (receipt.status === 'idempotency_conflict') {
        exactRecord(receipt, ['status'], 'PLATFORM_METERING_QUOTA_RECEIPT_INVALID');
        throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
      }
      exactRecord(receipt, ['status', 'quota'], 'PLATFORM_METERING_QUOTA_RECEIPT_INVALID');
      if (receipt.status !== 'updated' && receipt.status !== 'replay') {
        invalid('PLATFORM_METERING_QUOTA_RECEIPT_INVALID');
      }
      const quota = normalizeQuota({ dimension, ...receipt.quota });
      if (quota.state !== change.state) invalid('PLATFORM_METERING_QUOTA_RECEIPT_INVALID');
      return Object.freeze({
        schemaVersion: 1,
        status: receipt.status,
        tenantId,
        quota,
      });
    },

    async reconcileUsagePeriod(input) {
      exactRecord(
        input,
        ['operatorContext', 'tenantId', 'periodStart'],
        'PLATFORM_METERING_RECONCILIATION_INPUT_INVALID',
      );
      const tenantId = requireTenantId(input.tenantId);
      return reconcile({
        operatorContext: input.operatorContext,
        tenantId,
        periods: Object.freeze([requirePeriodStart(input.periodStart)]),
      });
    },

    async backfillUsagePeriods(input) {
      exactRecord(
        input,
        ['operatorContext', 'tenantId', 'fromPeriodStart', 'toPeriodStart'],
        'PLATFORM_METERING_BACKFILL_INPUT_INVALID',
      );
      const tenantId = requireTenantId(input.tenantId);
      return reconcile({
        operatorContext: input.operatorContext,
        tenantId,
        periods: periodsBetween(input.fromPeriodStart, input.toPeriodStart),
      });
    },
  });
}
