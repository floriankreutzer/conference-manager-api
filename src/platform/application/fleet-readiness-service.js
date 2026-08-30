import {
  authorizePlatformOperation,
  inputError,
  PLATFORM_OPERATION,
  requireBoundedText,
  requireClockTime,
  requireCount,
  requireCursor,
  requireDisplayName,
  requireExactObject,
  requireInternalId,
  requireLimit,
  requirePage,
  requirePort,
  requireRevision,
  requireSafeCode,
  requireTimestamp,
} from './platform-operation-contract.js';
import { PlatformOperationUnavailableError } from './platform-operation-errors.js';

const LIFECYCLE_STATUSES = new Set(['pending', 'onboarding', 'ready', 'active', 'suspended', 'archived']);
const ONBOARDING_STATES = new Set(['not_started', 'invited', 'claim_pending', 'claimed', 'complete']);
const CHECK_STATES = new Set(['pass', 'fail', 'unknown']);
const CHECK_CATEGORIES = new Set([
  'identity',
  'microsoft_connection',
  'permissions',
  'room_mapping',
  'capability_health',
  'entitlement',
  'repository_evidence',
  'deployment_evidence',
  'external_evidence',
]);
const READINESS_STATES = new Set(['ready', 'blocked', 'stale', 'unknown']);
const EVIDENCE_KINDS = new Set(['repository', 'deployment', 'external']);
const EVIDENCE_STATES = new Set(['verified', 'missing', 'invalid', 'unknown']);
const MAX_CHECKS = 64;

function unavailable(code) {
  throw new PlatformOperationUnavailableError(code);
}

function requireEnum(value, allowed, code) {
  if (typeof value !== 'string' || !allowed.has(value)) unavailable(code);
  return value;
}

function requireNullableSafeCode(value, code) {
  return value === null ? null : requireSafeCode(value, code);
}

export function freshnessForObservation({ observedAt, freshUntil }, asOfMs) {
  if (!Number.isSafeInteger(asOfMs) || asOfMs < 0) throw inputError('PLATFORM_READINESS_AS_OF_INVALID');
  if (observedAt === null || freshUntil === null) return 'unknown';
  const observedAtMs = Date.parse(requireTimestamp(observedAt, 'PLATFORM_READINESS_CHECK_INVALID'));
  const freshUntilMs = Date.parse(requireTimestamp(freshUntil, 'PLATFORM_READINESS_CHECK_INVALID'));
  if (freshUntilMs < observedAtMs) unavailable('PLATFORM_READINESS_CHECK_INVALID');
  return freshUntilMs > asOfMs ? 'fresh' : 'stale';
}

function check(value, asOfMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_READINESS_CHECK_INVALID');
  const observedAt = value.observedAt === null
    ? null
    : requireTimestamp(value.observedAt, 'PLATFORM_READINESS_CHECK_INVALID');
  const freshUntil = value.freshUntil === null
    ? null
    : requireTimestamp(value.freshUntil, 'PLATFORM_READINESS_CHECK_INVALID');
  return Object.freeze({
    checkId: requireSafeCode(value.checkId, 'PLATFORM_READINESS_CHECK_INVALID'),
    category: requireEnum(value.category, CHECK_CATEGORIES, 'PLATFORM_READINESS_CHECK_INVALID'),
    state: requireEnum(value.state, CHECK_STATES, 'PLATFORM_READINESS_CHECK_INVALID'),
    reasonCode: requireNullableSafeCode(value.reasonCode, 'PLATFORM_READINESS_CHECK_INVALID'),
    observedAt,
    freshness: freshnessForObservation({ observedAt, freshUntil }, asOfMs),
  });
}

function requiredIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    unavailable('PLATFORM_READINESS_POLICY_INVALID');
  }
  const ids = Object.freeze(value.map((item) => requireSafeCode(item, 'PLATFORM_READINESS_POLICY_INVALID')));
  if (new Set(ids).size !== ids.length) unavailable('PLATFORM_READINESS_POLICY_INVALID');
  return ids;
}

export function evaluateFleetReadinessSnapshot({ checks, requiredCheckIds, asOfMs }) {
  if (!Array.isArray(checks) || checks.length > MAX_CHECKS) unavailable('PLATFORM_READINESS_CHECK_INVALID');
  const normalized = Object.freeze(checks.map((item) => check(item, asOfMs)));
  const byId = new Map();
  for (const item of normalized) {
    if (byId.has(item.checkId)) unavailable('PLATFORM_READINESS_CHECK_INVALID');
    byId.set(item.checkId, item);
  }
  const required = requiredIds(requiredCheckIds);
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
  const state = hasFailure ? 'blocked' : hasUnknown ? 'unknown' : hasStale ? 'stale' : 'ready';
  return Object.freeze({
    state,
    blockerCodes: Object.freeze([...new Set(blockers)].sort()),
    checks: normalized,
  });
}

function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_READINESS_EVIDENCE_INVALID');
  const verifiedAt = value.verifiedAt === null
    ? null
    : requireTimestamp(value.verifiedAt, 'PLATFORM_READINESS_EVIDENCE_INVALID');
  const validUntil = value.validUntil === null
    ? null
    : requireTimestamp(value.validUntil, 'PLATFORM_READINESS_EVIDENCE_INVALID');
  return Object.freeze({
    kind: requireEnum(value.kind, EVIDENCE_KINDS, 'PLATFORM_READINESS_EVIDENCE_INVALID'),
    state: requireEnum(value.state, EVIDENCE_STATES, 'PLATFORM_READINESS_EVIDENCE_INVALID'),
    release: value.release === null
      ? null
      : requireBoundedText(value.release, {
        maximum: 80,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/,
        code: 'PLATFORM_READINESS_EVIDENCE_INVALID',
      }),
    verifiedAt,
    validUntil,
  });
}

function projectRow(value, readinessPolicy, asOfMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_READINESS_ROW_INVALID');
  const lifecycleStatus = requireEnum(
    value.lifecycleStatus,
    LIFECYCLE_STATUSES,
    'PLATFORM_READINESS_ROW_INVALID',
  );
  if (!Array.isArray(value.evidence) || value.evidence.length > EVIDENCE_KINDS.size) {
    unavailable('PLATFORM_READINESS_EVIDENCE_INVALID');
  }
  const evidenceItems = Object.freeze(value.evidence.map(evidence));
  if (new Set(evidenceItems.map((item) => item.kind)).size !== evidenceItems.length) {
    unavailable('PLATFORM_READINESS_EVIDENCE_INVALID');
  }
  const evaluation = evaluateFleetReadinessSnapshot({
    checks: value.checks,
    requiredCheckIds: readinessPolicy.requiredCheckIds({ lifecycleStatus }),
    asOfMs,
  });
  return Object.freeze({
    tenantId: requireInternalId(value.tenantId, 'PLATFORM_READINESS_ROW_INVALID'),
    displayName: requireDisplayName(value.displayName),
    lifecycle: Object.freeze({
      status: lifecycleStatus,
      revision: requireRevision(value.lifecycleRevision, 'PLATFORM_READINESS_ROW_INVALID'),
    }),
    onboardingState: requireEnum(value.onboardingState, ONBOARDING_STATES, 'PLATFORM_READINESS_ROW_INVALID'),
    readiness: evaluation,
    entitlements: Object.freeze({
      enabledCount: requireCount(value.enabledEntitlementCount, 'PLATFORM_READINESS_ROW_INVALID'),
      requiredMissingCount: requireCount(value.missingRequiredEntitlementCount, 'PLATFORM_READINESS_ROW_INVALID'),
    }),
    evidence: evidenceItems,
  });
}

export function createPlatformFleetReadinessService({
  readinessSnapshotReader,
  readinessPolicy,
  platformAuthorizationPolicy,
  tenantTargetPolicy,
  clock = () => Date.now(),
} = {}) {
  requirePort(readinessSnapshotReader, ['list'], 'PLATFORM_READINESS_SNAPSHOT_READER_REQUIRED');
  requirePort(readinessPolicy, ['requiredCheckIds'], 'PLATFORM_READINESS_POLICY_REQUIRED');
  requirePort(platformAuthorizationPolicy, ['authorize'], 'PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  requirePort(tenantTargetPolicy, ['queryScope'], 'PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_OPERATION_CLOCK_REQUIRED');

  return Object.freeze({
    async listFleetReadiness(input) {
      requireExactObject(input, ['operatorContext', 'query']);
      requireExactObject(
        input.query,
        ['limit', 'cursor', 'lifecycleStatus', 'readinessState', 'blockerCode'],
        [],
        'PLATFORM_READINESS_QUERY_INVALID',
      );
      const query = Object.freeze({
        limit: requireLimit(input.query.limit),
        cursor: input.query.cursor === undefined ? null : requireCursor(input.query.cursor),
        lifecycleStatus: input.query.lifecycleStatus === undefined
          ? null
          : requireEnum(input.query.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_READINESS_QUERY_INVALID'),
        readinessState: input.query.readinessState === undefined
          ? null
          : requireEnum(input.query.readinessState, READINESS_STATES, 'PLATFORM_READINESS_QUERY_INVALID'),
        blockerCode: input.query.blockerCode === undefined
          ? null
          : requireSafeCode(input.query.blockerCode, 'PLATFORM_READINESS_QUERY_INVALID'),
      });
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        operation: PLATFORM_OPERATION.READINESS_READ,
        fleet: true,
      });
      const page = requirePage(await readinessSnapshotReader.list({ query, authorization }));
      if (page.items.length > query.limit) unavailable('PLATFORM_READINESS_PAGE_INVALID');
      const asOfMs = Date.parse(page.snapshotAt);
      const nowMs = requireClockTime(clock);
      if (asOfMs > nowMs + 60_000) unavailable('PLATFORM_READINESS_SNAPSHOT_INVALID');
      return Object.freeze({
        schemaVersion: 1,
        snapshotAt: page.snapshotAt,
        items: Object.freeze(page.items.map((item) => projectRow(item, readinessPolicy, asOfMs))),
        nextCursor: page.nextCursor,
      });
    },
  });
}
