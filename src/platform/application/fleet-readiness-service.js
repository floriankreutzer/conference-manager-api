import {
  authorizePlatformOperation,
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
const READINESS_STATES = new Set(['ready', 'blocked', 'stale', 'unknown']);
const EVIDENCE_KINDS = new Set(['repository', 'deployment', 'external']);
const EVIDENCE_STATES = new Set(['verified', 'missing', 'invalid', 'unknown']);

function unavailable(code) {
  throw new PlatformOperationUnavailableError(code);
}

function requireEnum(value, allowed, code) {
  if (typeof value !== 'string' || !allowed.has(value)) unavailable(code);
  return value;
}

function evaluateReadiness(readinessPolicy, input) {
  try {
    return readinessPolicy.evaluateSnapshot(input);
  } catch (error) {
    if (error instanceof TypeError && /^TENANT_READINESS_/.test(error.code ?? error.message)) {
      unavailable((error.code ?? error.message) === 'TENANT_READINESS_POLICY_INVALID'
        ? 'PLATFORM_READINESS_POLICY_INVALID'
        : 'PLATFORM_READINESS_CHECK_INVALID');
    }
    throw error;
  }
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
  const evaluation = evaluateReadiness(readinessPolicy, {
    checks: value.checks,
    lifecycleStatus,
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
  requirePort(
    readinessPolicy,
    ['requiredCheckIds', 'evaluateSnapshot'],
    'PLATFORM_READINESS_POLICY_REQUIRED',
  );
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
