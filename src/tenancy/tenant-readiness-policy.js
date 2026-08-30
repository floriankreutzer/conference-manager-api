import { classifyObservationFreshness } from '../domain/observation-freshness.js';
import { TENANT_LIFECYCLE_STATUS } from './tenant-lifecycle-policy.js';

export const TENANT_READINESS_CHECK = Object.freeze({
  IDENTITY_ACTIVE: 'tenant.identity.active',
  MICROSOFT_CONNECTED: 'microsoft.connection.connected',
  PLACES_PERMISSION: 'microsoft.permission.places',
  CALENDARS_PERMISSION: 'microsoft.permission.calendars',
  ROOM_MAPPING_ACTIVE: 'microsoft.room_mapping.active',
  FREE_BUSY_HEALTHY: 'microsoft.free_busy.healthy',
  DIRECTORY_ENTITLED: 'entitlement.microsoft_directory',
  CALENDAR_ENTITLED: 'entitlement.microsoft_calendar',
});

export const TENANT_ACTIVATION_CAPABILITIES = Object.freeze([
  'microsoft.directory',
  'microsoft.calendar',
]);

const CHECK_CONTRACTS = new Map([
  [TENANT_READINESS_CHECK.IDENTITY_ACTIVE, Object.freeze({
    category: 'identity',
    failureReason: 'tenant.identity.inactive',
  })],
  [TENANT_READINESS_CHECK.MICROSOFT_CONNECTED, Object.freeze({
    category: 'microsoft_connection',
    failureReason: 'microsoft.connection.not_connected',
  })],
  [TENANT_READINESS_CHECK.PLACES_PERMISSION, Object.freeze({
    category: 'permissions',
    failureReason: 'microsoft.permission.places_missing',
  })],
  [TENANT_READINESS_CHECK.CALENDARS_PERMISSION, Object.freeze({
    category: 'permissions',
    failureReason: 'microsoft.permission.calendars_missing',
  })],
  [TENANT_READINESS_CHECK.ROOM_MAPPING_ACTIVE, Object.freeze({
    category: 'room_mapping',
    failureReason: 'microsoft.room_mapping.missing',
  })],
  [TENANT_READINESS_CHECK.FREE_BUSY_HEALTHY, Object.freeze({
    category: 'capability_health',
    failureReason: 'microsoft.free_busy.unhealthy',
  })],
  [TENANT_READINESS_CHECK.DIRECTORY_ENTITLED, Object.freeze({
    category: 'entitlement',
    failureReason: 'entitlement.microsoft_directory.missing',
  })],
  [TENANT_READINESS_CHECK.CALENDAR_ENTITLED, Object.freeze({
    category: 'entitlement',
    failureReason: 'entitlement.microsoft_calendar.missing',
  })],
]);
const LIFECYCLE_STATUSES = new Set(Object.values(TENANT_LIFECYCLE_STATUS));
const CHECK_STATES = new Set(['pass', 'fail', 'unknown']);
const CHECK_CATEGORIES = new Set([
  ...[...CHECK_CONTRACTS.values()].map((value) => value.category),
  'repository_evidence',
  'deployment_evidence',
  'external_evidence',
]);
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/;
const MAX_CHECKS = 64;
const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
const ACTIVATION_CHECKS = Object.freeze(Object.values(TENANT_READINESS_CHECK));

function invalid(code) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function requireSafeCode(value, code) {
  if (typeof value !== 'string' || !SAFE_CODE_PATTERN.test(value)) invalid(code);
  return value;
}

function requireTimestamp(value) {
  if (typeof value !== 'string') invalid('TENANT_READINESS_CHECK_INVALID');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid('TENANT_READINESS_CHECK_INVALID');
  }
  return value;
}

function requireCheckContract(checkId) {
  const contract = CHECK_CONTRACTS.get(checkId);
  if (!contract) invalid('TENANT_READINESS_CHECK_ID_INVALID');
  return contract;
}

function normalizeCheck(value, asOfMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('TENANT_READINESS_CHECK_INVALID');
  }
  const checkId = requireSafeCode(value.checkId, 'TENANT_READINESS_CHECK_INVALID');
  const category = requireSafeCode(value.category, 'TENANT_READINESS_CHECK_INVALID');
  if (!CHECK_CATEGORIES.has(category)) invalid('TENANT_READINESS_CHECK_INVALID');
  const state = value.state;
  if (typeof state !== 'string' || !CHECK_STATES.has(state)) {
    invalid('TENANT_READINESS_CHECK_INVALID');
  }
  const reasonCode = value.reasonCode === null
    ? null
    : requireSafeCode(value.reasonCode, 'TENANT_READINESS_CHECK_INVALID');
  const contract = CHECK_CONTRACTS.get(checkId);
  if (
    contract
    && (
      category !== contract.category
      || (state === 'fail' && reasonCode !== null && reasonCode !== contract.failureReason)
      || (state !== 'fail' && reasonCode !== null)
    )
  ) invalid('TENANT_READINESS_CHECK_INVALID');
  const observedAt = value.observedAt === null ? null : requireTimestamp(value.observedAt);
  const freshUntil = value.freshUntil === null ? null : requireTimestamp(value.freshUntil);
  let freshness;
  try {
    freshness = classifyObservationFreshness({
      observedAtMs: observedAt === null ? null : Date.parse(observedAt),
      freshUntilMs: freshUntil === null ? null : Date.parse(freshUntil),
      asOfMs,
    });
  } catch (error) {
    if (error instanceof TypeError && error.code === 'OBSERVATION_FRESHNESS_INVALID') {
      invalid('TENANT_READINESS_CHECK_INVALID');
    }
    throw error;
  }
  return Object.freeze({ checkId, category, state, reasonCode, observedAt, freshness });
}

function requireCheckIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    invalid('TENANT_READINESS_POLICY_INVALID');
  }
  const ids = Object.freeze(value.map((item) => requireSafeCode(
    item,
    'TENANT_READINESS_POLICY_INVALID',
  )));
  if (new Set(ids).size !== ids.length) invalid('TENANT_READINESS_POLICY_INVALID');
  return ids;
}

export function createTenantReadinessCheck({ checkId, passed, observedAt } = {}) {
  const contract = requireCheckContract(checkId);
  if (passed !== true && passed !== false && passed !== null) {
    invalid('TENANT_READINESS_CHECK_INVALID');
  }
  const normalizedObservedAt = observedAt === null ? null : requireTimestamp(observedAt);
  return Object.freeze({
    checkId,
    category: contract.category,
    state: passed === null ? 'unknown' : passed ? 'pass' : 'fail',
    reasonCode: passed === false ? contract.failureReason : null,
    observedAt: normalizedObservedAt,
    freshUntil: normalizedObservedAt === null
      ? null
      : new Date(Date.parse(normalizedObservedAt) + FRESHNESS_WINDOW_MS).toISOString(),
  });
}

export function requiredTenantReadinessCheckIds({ lifecycleStatus } = {}) {
  if (!LIFECYCLE_STATUSES.has(lifecycleStatus)) invalid('TENANT_READINESS_LIFECYCLE_INVALID');
  return ACTIVATION_CHECKS;
}

export function evaluateTenantReadinessSnapshot({ checks, requiredCheckIds, asOfMs } = {}) {
  if (!Number.isSafeInteger(asOfMs) || asOfMs < 0) invalid('TENANT_READINESS_AS_OF_INVALID');
  if (!Array.isArray(checks) || checks.length > MAX_CHECKS) {
    invalid('TENANT_READINESS_CHECK_INVALID');
  }
  const normalized = Object.freeze(checks.map((item) => normalizeCheck(item, asOfMs)));
  const byId = new Map();
  for (const item of normalized) {
    if (byId.has(item.checkId)) invalid('TENANT_READINESS_CHECK_INVALID');
    byId.set(item.checkId, item);
  }
  const required = requireCheckIds(requiredCheckIds);
  const blockers = [];
  let hasFailure = false;
  let hasUnknown = false;
  let hasStale = false;
  for (const checkId of required) {
    const item = byId.get(checkId);
    if (!item || item.state === 'unknown' || item.freshness === 'unknown') {
      hasUnknown = true;
      blockers.push(`${checkId}.unknown`);
      continue;
    }
    if (item.state === 'fail') {
      hasFailure = true;
      blockers.push(item.reasonCode ?? `${checkId}.failed`);
    }
    if (item.freshness === 'stale') {
      hasStale = true;
      blockers.push(`${checkId}.stale`);
    }
  }
  return Object.freeze({
    state: hasFailure ? 'blocked' : hasUnknown ? 'unknown' : hasStale ? 'stale' : 'ready',
    blockerCodes: Object.freeze([...new Set(blockers)].sort()),
    checks: normalized,
  });
}

export function createTenantReadinessPolicy() {
  return Object.freeze({
    requiredCheckIds: requiredTenantReadinessCheckIds,
    evaluateSnapshot({ checks, lifecycleStatus, asOfMs } = {}) {
      return evaluateTenantReadinessSnapshot({
        checks,
        requiredCheckIds: requiredTenantReadinessCheckIds({ lifecycleStatus }),
        asOfMs,
      });
    },
  });
}
