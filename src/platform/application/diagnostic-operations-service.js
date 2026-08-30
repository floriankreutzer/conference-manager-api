import {
  authorizePlatformOperation,
  createSensitiveReadEvidence,
  inputError,
  PLATFORM_OPERATION,
  requireBoundedText,
  requireClockTime,
  requireCount,
  requireDisplayName,
  requireExactObject,
  requireInternalId,
  requireLimit,
  requirePort,
  requireRelease,
  requireRevision,
  requireSafeCode,
  requireTimestamp,
} from './platform-operation-contract.js';
import { PlatformOperationUnavailableError } from './platform-operation-errors.js';

const LIFECYCLE_STATUSES = new Set(['pending', 'onboarding', 'ready', 'active', 'suspended', 'archived']);
const READINESS_STATES = new Set(['ready', 'blocked', 'stale', 'unknown']);
const CONNECTION_STATES = new Set(['not_configured', 'connected', 'degraded', 'disconnected']);
const HEALTH_STATES = new Set(['healthy', 'degraded', 'unavailable', 'revoked', 'unknown']);
const FRESHNESS_STATES = new Set(['fresh', 'stale', 'unknown']);
const CORRELATION_SOURCES = new Set(['tenant_audit', 'platform_audit', 'operation']);
const CORRELATION_OUTCOMES = new Set(['success', 'failure', 'denied', 'unknown']);
const MAX_FAILURES = 20;
const MAX_CORRELATION_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

function unavailable(code) {
  throw new PlatformOperationUnavailableError(code);
}

function requireEnum(value, allowed, code) {
  if (typeof value !== 'string' || !allowed.has(value)) unavailable(code);
  return value;
}

function safeCodes(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) unavailable(code);
  const result = Object.freeze(value.map((item) => requireSafeCode(item, code)));
  if (new Set(result).size !== result.length) unavailable(code);
  return result;
}

function diagnosticSummary(value, tenantId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
  if (requireInternalId(value.tenantId, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID') !== tenantId) {
    unavailable('PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
  }
  if (!Array.isArray(value.recentFailures) || value.recentFailures.length > MAX_FAILURES) {
    unavailable('PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
  }
  const activeMappings = requireCount(value.activeMappingCount, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
  const missingMappings = requireCount(value.missingMappingCount, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
  const totalMappings = requireCount(value.totalMappingCount, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
  if (activeMappings + missingMappings > totalMappings) unavailable('PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
  return Object.freeze({
    tenant: Object.freeze({
      tenantId,
      displayName: requireDisplayName(value.displayName),
      lifecycleStatus: requireEnum(value.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      lifecycleRevision: requireRevision(value.lifecycleRevision, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
    }),
    readiness: Object.freeze({
      state: requireEnum(value.readinessState, READINESS_STATES, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      blockerCodes: safeCodes(value.readinessBlockerCodes, 32, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      evaluatedAt: requireTimestamp(value.readinessEvaluatedAt, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
    }),
    entitlements: Object.freeze({
      revision: requireRevision(value.entitlementRevision, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      enabledCount: requireCount(value.enabledEntitlementCount, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
    }),
    microsoft: Object.freeze({
      connectionState: requireEnum(value.connectionState, CONNECTION_STATES, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      healthState: requireEnum(value.healthState, HEALTH_STATES, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      freshness: requireEnum(value.healthFreshness, FRESHNESS_STATES, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      lastCheckedAt: value.healthLastCheckedAt === null
        ? null
        : requireTimestamp(value.healthLastCheckedAt, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
    }),
    mappings: Object.freeze({ active: activeMappings, missing: missingMappings, total: totalMappings }),
    deployment: Object.freeze({
      release: requireRelease(value.deployedRelease, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      observedAt: requireTimestamp(value.deploymentObservedAt, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
    }),
    recentFailures: Object.freeze(value.recentFailures.map((failure) => {
      if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
        unavailable('PLATFORM_DIAGNOSTIC_SUMMARY_INVALID');
      }
      return Object.freeze({
        category: requireSafeCode(failure.category, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
        occurredAt: requireTimestamp(failure.occurredAt, 'PLATFORM_DIAGNOSTIC_SUMMARY_INVALID'),
      });
    })),
  });
}

function correlationEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_DIAGNOSTIC_CORRELATION_INVALID');
  return Object.freeze({
    source: requireEnum(value.source, CORRELATION_SOURCES, 'PLATFORM_DIAGNOSTIC_CORRELATION_INVALID'),
    occurredAt: requireTimestamp(value.occurredAt, 'PLATFORM_DIAGNOSTIC_CORRELATION_INVALID'),
    action: requireSafeCode(value.action, 'PLATFORM_DIAGNOSTIC_CORRELATION_INVALID'),
    outcome: requireEnum(value.outcome, CORRELATION_OUTCOMES, 'PLATFORM_DIAGNOSTIC_CORRELATION_INVALID'),
    category: value.category === null
      ? null
      : requireSafeCode(value.category, 'PLATFORM_DIAGNOSTIC_CORRELATION_INVALID'),
    targetType: value.targetType === null
      ? null
      : requireSafeCode(value.targetType, 'PLATFORM_DIAGNOSTIC_CORRELATION_INVALID'),
  });
}

function timeRange(from, to) {
  const normalizedFrom = requireTimestamp(from, 'PLATFORM_DIAGNOSTIC_TIME_RANGE_INVALID');
  const normalizedTo = requireTimestamp(to, 'PLATFORM_DIAGNOSTIC_TIME_RANGE_INVALID');
  const fromMs = Date.parse(normalizedFrom);
  const toMs = Date.parse(normalizedTo);
  if (fromMs >= toMs || toMs - fromMs > MAX_CORRELATION_WINDOW_MS) {
    throw inputError('PLATFORM_DIAGNOSTIC_TIME_RANGE_INVALID');
  }
  return Object.freeze({ from: normalizedFrom, to: normalizedTo });
}

export function createPlatformDiagnosticOperationsService({
  diagnosticReader,
  platformAuthorizationPolicy,
  tenantTargetPolicy,
  operationEvidenceFactory,
  clock = () => Date.now(),
} = {}) {
  requirePort(
    diagnosticReader,
    ['readSummaryAndRecordAccess', 'queryTenantCorrelationAndRecordAccess'],
    'PLATFORM_DIAGNOSTIC_READER_REQUIRED',
  );
  requirePort(platformAuthorizationPolicy, ['authorize'], 'PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  requirePort(tenantTargetPolicy, ['authorize'], 'PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  requirePort(
    operationEvidenceFactory,
    ['createSensitiveRead'],
    'PLATFORM_OPERATION_EVIDENCE_FACTORY_REQUIRED',
  );
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_OPERATION_CLOCK_REQUIRED');

  async function authorizeAndEvidence({ operatorContext, operation, tenantId, correlationId, target }) {
    const authorization = await authorizePlatformOperation({
      authorizationPolicy: platformAuthorizationPolicy,
      tenantTargetPolicy,
      operatorContext,
      operation,
      tenantId,
    });
    const occurredAt = new Date(requireClockTime(clock)).toISOString();
    const evidence = await createSensitiveReadEvidence({
      evidenceFactory: operationEvidenceFactory,
      authorization,
      operation,
      tenantId,
      correlationId,
      target,
      occurredAt,
    });
    return Object.freeze({ authorization, evidence, occurredAt });
  }

  return Object.freeze({
    async getTenantSummary(input) {
      requireExactObject(input, ['operatorContext', 'tenantId', 'correlationId']);
      const tenantId = requireInternalId(input.tenantId, 'PLATFORM_TENANT_ID_INVALID');
      const correlationId = requireInternalId(input.correlationId, 'PLATFORM_CORRELATION_ID_INVALID');
      const access = await authorizeAndEvidence({
        operatorContext: input.operatorContext,
        operation: PLATFORM_OPERATION.DIAGNOSTIC_SUMMARY_READ,
        tenantId,
        correlationId,
        target: Object.freeze({ type: 'tenant_diagnostics', id: tenantId }),
      });
      const result = await diagnosticReader.readSummaryAndRecordAccess({
        tenantId,
        correlationId,
        ...access,
      });
      if (!result) unavailable('PLATFORM_DIAGNOSTIC_SUMMARY_UNAVAILABLE');
      return Object.freeze({ schemaVersion: 1, summary: diagnosticSummary(result, tenantId) });
    },

    async lookupCorrelation(input) {
      requireExactObject(input, [
        'operatorContext',
        'tenantId',
        'correlationId',
        'lookupCorrelationId',
        'from',
        'to',
        'limit',
      ]);
      const tenantId = requireInternalId(input.tenantId, 'PLATFORM_TENANT_ID_INVALID');
      const correlationId = requireInternalId(input.correlationId, 'PLATFORM_CORRELATION_ID_INVALID');
      const lookupCorrelationId = requireInternalId(
        input.lookupCorrelationId,
        'PLATFORM_DIAGNOSTIC_LOOKUP_CORRELATION_INVALID',
      );
      const range = timeRange(input.from, input.to);
      const limit = requireLimit(input.limit, { defaultValue: 50, maximum: 100 });
      const access = await authorizeAndEvidence({
        operatorContext: input.operatorContext,
        operation: PLATFORM_OPERATION.DIAGNOSTIC_CORRELATION_READ,
        tenantId,
        correlationId,
        target: Object.freeze({ type: 'tenant_correlation', id: lookupCorrelationId }),
      });
      const result = await diagnosticReader.queryTenantCorrelationAndRecordAccess({
        tenantId,
        lookupCorrelationId,
        from: range.from,
        to: range.to,
        limit,
        correlationId,
        ...access,
      });
      if (!Array.isArray(result) || result.length > limit) unavailable('PLATFORM_DIAGNOSTIC_CORRELATION_INVALID');
      return Object.freeze({
        schemaVersion: 1,
        tenantId,
        lookupCorrelationId,
        from: range.from,
        to: range.to,
        items: Object.freeze(result.map(correlationEntry)),
      });
    },
  });
}
