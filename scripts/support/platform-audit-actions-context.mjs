import { normalizePlatformAuditSegmentRequest } from '../../src/operator/platform-audit-segment-request.js';
import { platformAuditSegmentRoleGrantPlan } from './protected-runtime-role-grants.mjs';
import { requireOwnerMainActionsContext } from './owner-main-actions-context.mjs';

const refuse = () => { throw new Error('PLATFORM_AUDIT_ACTIONS_REFUSED'); };
function json(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) refuse();
  return JSON.parse(value);
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) refuse();
}

// This is a provenance/attestation gate, not an implementation of restore or signing.
// The existing offline CLIs remain the sole mutation and database authority.
export function requirePlatformAuditActionsContext(env) {
  try {
    requireOwnerMainActionsContext(env, 'protected-int-audit-segment.yml');
    if (!['initialize', 'grants'].includes(env.INT_AUDIT_OPERATION)) refuse();
    const expected = json(env.CM_INT_AUDIT_EXPECTED_JSON);
    // Reuse the canonical closed request validator for independent expected values.
    const request = json(env.CM_INT_AUDIT_REQUEST_JSON);
    if (env.INT_AUDIT_OPERATION === 'initialize') normalizePlatformAuditSegmentRequest(request, expected);
    else {
      normalizePlatformAuditSegmentRequest({ ...expected, approvalReference: 'grant-context',
        correlationId: expected.segmentId }, expected);
      const plan = platformAuditSegmentRoleGrantPlan(request);
      if (request.environment !== 'int' || plan.segmentId !== expected.segmentId
        || request.securityEpoch !== expected.deploymentEpoch) refuse();
    }
    const evidence = json(env.CM_INT_AUDIT_RECOVERY_EVIDENCE);
    exact(evidence, ['sourceSha', 'environment', 'deploymentEpoch', 'restoreReference', 'custodyReference', 'servicesClosed']);
    if (evidence.sourceSha !== env.GITHUB_SHA || evidence.environment !== 'int'
      || evidence.deploymentEpoch !== expected.deploymentEpoch || evidence.servicesClosed !== true
      || ![evidence.restoreReference, evidence.custodyReference].every(value =>
        typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value))) refuse();
    const count = env.PLATFORM_AUDIT_SEGMENT_LEGACY_EVENT_COUNT;
    if (!/^(0|[1-9]\d{0,3})$/.test(count || '') || Number(count) !== expected.legacyEventCount
      || env.PLATFORM_AUDIT_SEGMENT_ID !== expected.segmentId
      || env.PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH !== expected.deploymentEpoch
      || env.PLATFORM_AUDIT_SEGMENT_INVENTORY_DIGEST !== expected.inventoryDigest) refuse();
    return env.INT_AUDIT_OPERATION;
  } catch { refuse(); }
}
