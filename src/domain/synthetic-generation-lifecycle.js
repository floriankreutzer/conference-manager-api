import { createHash } from 'node:crypto';
import { isInternalUuid } from './identifiers.js';

export const SYNTHETIC_GENERATION_REPLACE='synthetic.generation.replace';
export const SYNTHETIC_GENERATION_COOLDOWN_MS=10_000;
export const SYNTHETIC_GENERATION_RETENTION_LIMIT=32;

function invalid() { throw new TypeError('SYNTHETIC_GENERATION_INTENT_INVALID'); }
export function normalizeSyntheticGenerationIntent(value) {
  if (!value || Object.keys(value).sort().join(',')!=='expectedGenerationId,expectedRevision,operatorId'
    || !isInternalUuid(value.operatorId)
    || !(value.expectedGenerationId===null || isInternalUuid(value.expectedGenerationId))
    || !Number.isSafeInteger(value.expectedRevision)
    || (value.expectedGenerationId===null ? value.expectedRevision!==0 : value.expectedRevision<1)) invalid();
  return Object.freeze({ operatorId: value.operatorId.toLowerCase(),
    expectedGenerationId: value.expectedGenerationId?.toLowerCase() ?? null,expectedRevision: value.expectedRevision });
}

export function syntheticGenerationOperationHash({ environment,securityEpoch },value) {
  if (!['dev','int'].includes(environment) || !isInternalUuid(securityEpoch)) invalid();
  const intent=normalizeSyntheticGenerationIntent(value);
  return createHash('sha256').update(JSON.stringify({ operation: SYNTHETIC_GENERATION_REPLACE,
    environment,securityEpoch: securityEpoch.toLowerCase(),...intent }),'utf8').digest('hex');
}

// This exception is exclusively for an immutable owned synthetic registry row.
// It does not broaden the ordinary real-Tenant lifecycle transition policy.
export function requireOwnedSyntheticTenantArchival(scope,tenant) {
  if (!scope || !['dev','int'].includes(scope.environment) || !isInternalUuid(scope.operatorId)
    || !isInternalUuid(scope.generationId) || !tenant
    || tenant.environment!==scope.environment || tenant.mode!=='synthetic'
    || tenant.operatorId!==scope.operatorId || tenant.generationId!==scope.generationId
    || !isInternalUuid(tenant.tenantId) || !['northwind','contoso','fabrikam'].includes(tenant.slot)
    || !['onboarding','ready','active','suspended','archived'].includes(tenant.status)
    || !Number.isSafeInteger(tenant.revision) || tenant.revision<1) {
    throw new TypeError('SYNTHETIC_TENANT_ARCHIVAL_DENIED');
  }
  return true;
}
