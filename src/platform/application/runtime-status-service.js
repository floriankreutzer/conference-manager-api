import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_AUDIT_ACTION, PLATFORM_AUDIT_RETENTION } from '../audit/event.js';
import { PlatformAuthorizationError } from '../identity/errors.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { PlatformOperationDeniedError } from './platform-operation-errors.js';

export const PLATFORM_RUNTIME_METADATA_STATE = Object.freeze({
  CURRENT: 'current',
  MISMATCH: 'mismatch',
  STALE: 'stale',
  UNKNOWN: 'unknown',
});

export const PLATFORM_RUNTIME_OPERATIONAL_STATE = Object.freeze({
  READY: 'ready',
  DEGRADED: 'degraded',
  NOT_READY: 'not_ready',
  UNKNOWN: 'unknown',
});

const ENVIRONMENTS = new Set(['development', 'test', 'pilot', 'production']);
const REQUIRED_DEPENDENCY_STATES = new Set(['ready', 'not_ready', 'unknown']);
const OPTIONAL_DEPENDENCY_STATES = new Set(['ready', 'degraded', 'unknown']);
const SUPPORT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEPLOYMENT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EVIDENCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,254}$/;
const DEFAULT_MAX_FRESHNESS_AGE_MS = 5 * 60 * 1_000;
const MAX_DEPLOYMENTS = 50;

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
  if (!isInternalUuid(value)) invalid('PLATFORM_RUNTIME_TENANT_ID_INVALID');
  return value;
}

function requireEnvironment(value) {
  if (!ENVIRONMENTS.has(value)) invalid('PLATFORM_RUNTIME_ENVIRONMENT_INVALID');
  return value;
}

function optionalCanonicalInstant(value, code) {
  if (value === null) return null;
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

function optionalIdentifier(value, code) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SUPPORT_IDENTIFIER.test(value)) invalid(code);
  return value;
}

function optionalDeploymentReference(value) {
  if (
    value !== null
    && (
      typeof value !== 'string'
      || !DEPLOYMENT_REFERENCE.test(value)
      || value.includes('://')
    )
  ) {
    invalid('PLATFORM_RUNTIME_DEPLOYMENT_REFERENCE_INVALID');
  }
  return value;
}

function optionalEvidenceReference(value) {
  if (
    value !== null
    && (
      typeof value !== 'string'
      || !EVIDENCE_REFERENCE.test(value)
      || value.includes('://')
    )
  ) {
    invalid('PLATFORM_RUNTIME_EVIDENCE_REFERENCE_INVALID');
  }
  return value;
}

function optionalSchemaVersion(value, { expected }) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < (expected ? 1 : 0) || value > 100_000) {
    invalid('PLATFORM_RUNTIME_SCHEMA_VERSION_INVALID');
  }
  return value;
}

function correlated(value, environment, deploymentReference, subject, reasons) {
  if (value.environment !== environment) reasons.push(`${subject}_environment_mismatch`);
  if (value.deploymentReference !== deploymentReference) {
    reasons.push(`${subject}_deployment_mismatch`);
  }
}

function component(value, environment, deploymentReference, subject, reasons) {
  exactRecord(value, [
    'environment',
    'deploymentReference',
    'expectedVersion',
    'expectedBuildId',
    'version',
    'buildId',
  ], 'PLATFORM_RUNTIME_COMPONENT_INVALID');
  requireEnvironment(value.environment);
  const sourceDeploymentReference = optionalDeploymentReference(value.deploymentReference);
  const expectedVersion = optionalIdentifier(
    value.expectedVersion,
    'PLATFORM_RUNTIME_COMPONENT_IDENTIFIER_INVALID',
  );
  const expectedBuildId = optionalIdentifier(
    value.expectedBuildId,
    'PLATFORM_RUNTIME_COMPONENT_IDENTIFIER_INVALID',
  );
  const version = optionalIdentifier(value.version, 'PLATFORM_RUNTIME_COMPONENT_IDENTIFIER_INVALID');
  const buildId = optionalIdentifier(value.buildId, 'PLATFORM_RUNTIME_COMPONENT_IDENTIFIER_INVALID');
  const missing = [expectedVersion, expectedBuildId, version, buildId].some((entry) => entry === null);
  if (missing) reasons.push(`${subject}_metadata_missing`);
  correlated(
    { environment: value.environment, deploymentReference: sourceDeploymentReference },
    environment,
    deploymentReference,
    subject,
    reasons,
  );
  const mismatched = !missing && (expectedVersion !== version || expectedBuildId !== buildId);
  if (mismatched) reasons.push(`${subject}_version_mismatch`);
  const correlationMismatch = value.environment !== environment
    || sourceDeploymentReference !== deploymentReference;
  return Object.freeze({
    expectedVersion,
    expectedBuildId,
    version,
    buildId,
    state: missing
      ? PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN
      : mismatched || correlationMismatch
        ? PLATFORM_RUNTIME_METADATA_STATE.MISMATCH
        : PLATFORM_RUNTIME_METADATA_STATE.CURRENT,
  });
}

function databaseSchema(value, environment, deploymentReference, reasons) {
  exactRecord(value, [
    'environment',
    'deploymentReference',
    'expectedVersion',
    'currentVersion',
  ], 'PLATFORM_RUNTIME_SCHEMA_INVALID');
  requireEnvironment(value.environment);
  const sourceDeploymentReference = optionalDeploymentReference(value.deploymentReference);
  const expectedVersion = optionalSchemaVersion(value.expectedVersion, { expected: true });
  const currentVersion = optionalSchemaVersion(value.currentVersion, { expected: false });
  const missing = expectedVersion === null || currentVersion === null;
  if (missing) reasons.push('schema_metadata_missing');
  correlated(
    { environment: value.environment, deploymentReference: sourceDeploymentReference },
    environment,
    deploymentReference,
    'schema',
    reasons,
  );
  const mismatched = !missing && expectedVersion !== currentVersion;
  if (mismatched) reasons.push('schema_version_mismatch');
  const correlationMismatch = value.environment !== environment
    || sourceDeploymentReference !== deploymentReference;
  return Object.freeze({
    expectedVersion,
    currentVersion,
    state: missing
      ? PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN
      : mismatched || correlationMismatch
        ? PLATFORM_RUNTIME_METADATA_STATE.MISMATCH
        : PLATFORM_RUNTIME_METADATA_STATE.CURRENT,
  });
}

function dependencies(value, environment, deploymentReference, reasons) {
  exactRecord(value, [
    'environment',
    'deploymentReference',
    'required',
    'optional',
  ], 'PLATFORM_RUNTIME_DEPENDENCIES_INVALID');
  requireEnvironment(value.environment);
  const sourceDeploymentReference = optionalDeploymentReference(value.deploymentReference);
  if (
    !REQUIRED_DEPENDENCY_STATES.has(value.required)
    || !OPTIONAL_DEPENDENCY_STATES.has(value.optional)
  ) {
    invalid('PLATFORM_RUNTIME_DEPENDENCIES_INVALID');
  }
  correlated(
    { environment: value.environment, deploymentReference: sourceDeploymentReference },
    environment,
    deploymentReference,
    'dependencies',
    reasons,
  );
  if (value.required === 'unknown') reasons.push('required_dependencies_unknown');
  if (value.optional === 'unknown') reasons.push('optional_dependencies_unknown');
  if (value.required === 'not_ready') reasons.push('required_dependencies_not_ready');
  if (value.optional === 'degraded') reasons.push('optional_dependencies_degraded');
  let state = PLATFORM_RUNTIME_OPERATIONAL_STATE.READY;
  if (value.required === 'not_ready') {
    state = PLATFORM_RUNTIME_OPERATIONAL_STATE.NOT_READY;
  } else if (value.required === 'unknown' || value.optional === 'unknown') {
    state = PLATFORM_RUNTIME_OPERATIONAL_STATE.UNKNOWN;
  } else if (value.optional === 'degraded') {
    state = PLATFORM_RUNTIME_OPERATIONAL_STATE.DEGRADED;
  }
  return Object.freeze({ required: value.required, optional: value.optional, state });
}

function evidence(value, reasons) {
  exactRecord(
    value,
    ['release', 'change', 'rollback', 'runbook'],
    'PLATFORM_RUNTIME_EVIDENCE_INVALID',
  );
  const result = Object.freeze({
    release: optionalEvidenceReference(value.release),
    change: optionalEvidenceReference(value.change),
    rollback: optionalEvidenceReference(value.rollback),
    runbook: optionalEvidenceReference(value.runbook),
  });
  for (const [name, reference] of Object.entries(result)) {
    if (reference === null) reasons.push(`${name}_evidence_missing`);
  }
  return result;
}

function freshness(observedAt, now, maxFreshnessAgeMs, reasons) {
  if (observedAt === null) {
    reasons.push('runtime_observation_missing');
    return Object.freeze({ state: 'unknown', observedAt: null, maxAgeSeconds: maxFreshnessAgeMs / 1_000 });
  }
  const observedMilliseconds = Date.parse(observedAt);
  if (observedMilliseconds > now) {
    reasons.push('runtime_observation_in_future');
    return Object.freeze({ state: 'unknown', observedAt, maxAgeSeconds: maxFreshnessAgeMs / 1_000 });
  }
  if (now - observedMilliseconds > maxFreshnessAgeMs) {
    reasons.push('runtime_observation_stale');
    return Object.freeze({ state: 'stale', observedAt, maxAgeSeconds: maxFreshnessAgeMs / 1_000 });
  }
  return Object.freeze({ state: 'fresh', observedAt, maxAgeSeconds: maxFreshnessAgeMs / 1_000 });
}

function overallState(metadataState, operationalState) {
  if (operationalState === PLATFORM_RUNTIME_OPERATIONAL_STATE.NOT_READY) return 'not_ready';
  if (metadataState === PLATFORM_RUNTIME_METADATA_STATE.MISMATCH) return 'mismatch';
  if (metadataState === PLATFORM_RUNTIME_METADATA_STATE.STALE) return 'stale';
  if (
    metadataState === PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN
    || operationalState === PLATFORM_RUNTIME_OPERATIONAL_STATE.UNKNOWN
  ) {
    return 'unknown';
  }
  return operationalState;
}

function projectRuntime(value, now, maxFreshnessAgeMs) {
  exactRecord(value, [
    'environment',
    'deployment',
    'frontend',
    'api',
    'schema',
    'dependencies',
    'observedAt',
    'evidence',
  ], 'PLATFORM_RUNTIME_RECORD_INVALID');
  const environment = requireEnvironment(value.environment);
  exactRecord(
    value.deployment,
    ['reference', 'deployedAt'],
    'PLATFORM_RUNTIME_DEPLOYMENT_INVALID',
  );
  const deploymentReference = optionalDeploymentReference(value.deployment.reference);
  const deployedAt = optionalCanonicalInstant(
    value.deployment.deployedAt,
    'PLATFORM_RUNTIME_DEPLOYMENT_TIME_INVALID',
  );
  const observedAt = optionalCanonicalInstant(
    value.observedAt,
    'PLATFORM_RUNTIME_OBSERVED_AT_INVALID',
  );
  const reasons = [];
  if (deploymentReference === null) reasons.push('deployment_reference_missing');
  if (deployedAt === null) reasons.push('deployment_time_missing');
  if (deployedAt !== null && observedAt !== null && Date.parse(deployedAt) > Date.parse(observedAt)) {
    reasons.push('deployment_time_after_observation');
  }
  const frontend = component(
    value.frontend,
    environment,
    deploymentReference,
    'frontend',
    reasons,
  );
  const api = component(value.api, environment, deploymentReference, 'api', reasons);
  const schema = databaseSchema(value.schema, environment, deploymentReference, reasons);
  const dependencySummary = dependencies(
    value.dependencies,
    environment,
    deploymentReference,
    reasons,
  );
  const evidenceProjection = evidence(value.evidence, reasons);
  const freshnessProjection = freshness(observedAt, now, maxFreshnessAgeMs, reasons);
  const hasUnknownMetadata = deploymentReference === null
    || deployedAt === null
    || frontend.state === PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN
    || api.state === PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN
    || schema.state === PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN
    || Object.values(evidenceProjection).some((reference) => reference === null)
    || freshnessProjection.state === 'unknown';
  const hasMismatch = frontend.state === PLATFORM_RUNTIME_METADATA_STATE.MISMATCH
    || api.state === PLATFORM_RUNTIME_METADATA_STATE.MISMATCH
    || schema.state === PLATFORM_RUNTIME_METADATA_STATE.MISMATCH
    || reasons.includes('dependencies_environment_mismatch')
    || reasons.includes('dependencies_deployment_mismatch')
    || reasons.includes('deployment_time_after_observation');
  let metadataState = PLATFORM_RUNTIME_METADATA_STATE.CURRENT;
  if (hasMismatch) metadataState = PLATFORM_RUNTIME_METADATA_STATE.MISMATCH;
  else if (freshnessProjection.state === 'stale') metadataState = PLATFORM_RUNTIME_METADATA_STATE.STALE;
  else if (hasUnknownMetadata) metadataState = PLATFORM_RUNTIME_METADATA_STATE.UNKNOWN;
  return Object.freeze({
    schemaVersion: 1,
    environment,
    deployment: Object.freeze({ reference: deploymentReference, deployedAt }),
    components: Object.freeze({ frontend, api }),
    databaseSchema: schema,
    dependencies: dependencySummary,
    freshness: freshnessProjection,
    evidence: evidenceProjection,
    metadataState,
    operationalState: dependencySummary.state,
    overallState: overallState(metadataState, dependencySummary.state),
    reasonCodes: Object.freeze([...new Set(reasons)]),
  });
}

function runtimeClock(clock) {
  const milliseconds = clock();
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || !Number.isFinite(new Date(milliseconds).getTime())
  ) {
    invalid('PLATFORM_RUNTIME_CLOCK_INVALID');
  }
  return milliseconds;
}

async function authorizePermission(authorizationPolicy, operatorContext) {
  let decision;
  try {
    decision = await authorizationPolicy.authorize(
      operatorContext,
      PLATFORM_PERMISSION.RUNTIME_READ,
    );
  } catch (error) {
    if (error instanceof PlatformAuthorizationError) {
      throw new PlatformOperationDeniedError(error.code);
    }
    throw error;
  }
  if (decision !== true) throw new PlatformOperationDeniedError();
}

async function authorizeTenantTarget(tenantTargetPolicy, operatorContext, tenantId) {
  let decision;
  try {
    decision = await tenantTargetPolicy.authorize(operatorContext, tenantId);
  } catch (error) {
    if (error instanceof PlatformAuthorizationError) {
      throw new PlatformOperationDeniedError(error.code);
    }
    throw error;
  }
  if (decision !== true) throw new PlatformOperationDeniedError();
}

function validateRuntime({
  repository,
  authorizationPolicy,
  tenantTargetPolicy,
  auditService,
  clock,
  maxFreshnessAgeMs,
}) {
  if (
    !repository
    || typeof repository.listApprovedDeployments !== 'function'
    || typeof repository.findServingDeploymentByTenantId !== 'function'
  ) {
    invalid('PLATFORM_RUNTIME_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.authorize !== 'function') {
    invalid('PLATFORM_RUNTIME_AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!tenantTargetPolicy || typeof tenantTargetPolicy.authorize !== 'function') {
    invalid('PLATFORM_RUNTIME_TENANT_TARGET_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createEvent !== 'function') {
    invalid('PLATFORM_RUNTIME_AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function') invalid('PLATFORM_RUNTIME_CLOCK_REQUIRED');
  if (
    !Number.isSafeInteger(maxFreshnessAgeMs)
    || maxFreshnessAgeMs < 1_000
    || maxFreshnessAgeMs > 24 * 60 * 60 * 1_000
    || maxFreshnessAgeMs % 1_000 !== 0
  ) {
    invalid('PLATFORM_RUNTIME_FRESHNESS_AGE_INVALID');
  }
}

export function createPlatformRuntimeStatusService({
  repository,
  authorizationPolicy,
  tenantTargetPolicy,
  auditService,
  clock = () => Date.now(),
  maxFreshnessAgeMs = DEFAULT_MAX_FRESHNESS_AGE_MS,
} = {}) {
  validateRuntime({
    repository,
    authorizationPolicy,
    tenantTargetPolicy,
    auditService,
    clock,
    maxFreshnessAgeMs,
  });

  return Object.freeze({
    async listApprovedDeployments(input) {
      exactRecord(input, ['operatorContext'], 'PLATFORM_RUNTIME_LIST_INPUT_INVALID');
      await authorizePermission(authorizationPolicy, input.operatorContext);
      const records = await repository.listApprovedDeployments({
        auditEventFor: ({ resultCount }) => auditService.createEvent({
          principal: input.operatorContext,
          action: PLATFORM_AUDIT_ACTION.RUNTIME_READ,
          targetType: 'runtime_deployments',
          targetId: 'approved',
          metadata: Object.freeze({ resultCount }),
          retentionClass: PLATFORM_AUDIT_RETENTION.ADMINISTRATIVE,
        }),
      });
      if (!Array.isArray(records) || records.length > MAX_DEPLOYMENTS) {
        invalid('PLATFORM_RUNTIME_DEPLOYMENT_LIST_INVALID');
      }
      const now = runtimeClock(clock);
      const deployments = records.map((record) => projectRuntime(record, now, maxFreshnessAgeMs));
      const keys = deployments.map((deployment) => {
        return `${deployment.environment}\u0000${deployment.deployment.reference ?? ''}`;
      });
      if (new Set(keys).size !== keys.length) invalid('PLATFORM_RUNTIME_DUPLICATE_DEPLOYMENT');
      return Object.freeze({ schemaVersion: 1, deployments: Object.freeze(deployments) });
    },

    async getServingDeploymentForTenant(input) {
      exactRecord(
        input,
        ['operatorContext', 'tenantId'],
        'PLATFORM_RUNTIME_TENANT_LOOKUP_INPUT_INVALID',
      );
      const tenantId = requireTenantId(input.tenantId);
      await authorizePermission(authorizationPolicy, input.operatorContext);
      await authorizeTenantTarget(tenantTargetPolicy, input.operatorContext, tenantId);
      const result = await repository.findServingDeploymentByTenantId(tenantId, {
        auditEventFor: ({ correlationState }) => auditService.createEvent({
          principal: input.operatorContext,
          action: PLATFORM_AUDIT_ACTION.RUNTIME_READ,
          targetType: 'tenant_runtime',
          targetId: tenantId,
          targetTenantId: tenantId,
          metadata: Object.freeze({ correlationState }),
          retentionClass: PLATFORM_AUDIT_RETENTION.ADMINISTRATIVE,
        }),
      });
      if (result === null) {
        return Object.freeze({
          schemaVersion: 1,
          tenantId,
          correlationState: 'unknown',
          runtime: null,
        });
      }
      exactRecord(result, ['tenantId', 'runtime'], 'PLATFORM_RUNTIME_TENANT_MAPPING_INVALID');
      if (result.tenantId !== tenantId) invalid('PLATFORM_RUNTIME_TENANT_SCOPE_MISMATCH');
      return Object.freeze({
        schemaVersion: 1,
        tenantId,
        correlationState: 'mapped',
        runtime: projectRuntime(result.runtime, runtimeClock(clock), maxFreshnessAgeMs),
      });
    },
  });
}
