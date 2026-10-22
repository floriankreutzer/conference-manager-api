import { normalizePlatformOwnerBootstrapRequest } from '../../src/operator/platform-owner-bootstrap-request.js';
import { requireOwnerMainActionsContext } from './owner-main-actions-context.mjs';

const refuse = () => { throw new Error('PLATFORM_OWNER_ACTIONS_REFUSED'); };
function json(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) refuse();
  return JSON.parse(value);
}

// Attestation binding only. The existing offline CLI remains the database authority.
export function requirePlatformOwnerActionsContext(env) {
  try {
    requireOwnerMainActionsContext(env, 'protected-int-first-owner.yml');
    const expected = { environment: 'int', deploymentEpoch: env.PLATFORM_OWNER_BOOTSTRAP_DEPLOYMENT_EPOCH,
      directoryId: env.PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID, subjectId: env.PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID };
    normalizePlatformOwnerBootstrapRequest(json(env.CM_INT_OWNER_REQUEST_JSON), expected);
    const evidence = json(env.CM_INT_OWNER_EVIDENCE);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).sort().join(',') !==
        ['sourceSha','environment','deploymentEpoch','segmentId','identityReference','servicesClosed'].sort().join(',')
      || evidence.sourceSha !== env.GITHUB_SHA || evidence.environment !== 'int'
      || evidence.deploymentEpoch !== expected.deploymentEpoch || evidence.servicesClosed !== true
      || evidence.segmentId !== env.PLATFORM_AUDIT_SEGMENT_ID
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(evidence.segmentId || '')
      || env.PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH !== expected.deploymentEpoch
      || typeof evidence.identityReference !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(evidence.identityReference)) refuse();
    return true;
  } catch { refuse(); }
}
