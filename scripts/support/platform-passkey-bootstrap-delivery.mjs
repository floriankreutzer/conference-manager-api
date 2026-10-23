import { constants, createHash, createPublicKey, publicEncrypt } from 'node:crypto';
import { createPlatformPasskeyEnrollmentGrant, normalizePlatformPasskeyEnrollmentGrantClaim }
  from '../../src/platform/identity/passkey-enrollment-grant.js';
import { requireOwnerMainActionsContext } from './owner-main-actions-context.mjs';

const FORMAT = 'cm-int-passkey-bootstrap:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = () => { throw new Error('PLATFORM_PASSKEY_BOOTSTRAP_DELIVERY_REFUSED'); };
function json(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) refuse();
  return JSON.parse(value);
}

// Transport binding only; canonical offline issuance remains the sole writer.
export function requirePlatformPasskeyBootstrapDeliveryContext(env) {
  try {
    const recoveryWorkflow = 'protected-int-passkey-recovery.yml';
    const recovery = env.GITHUB_WORKFLOW_REF ===
      `floriankreutzer/conference-manager-api/.github/workflows/${recoveryWorkflow}@refs/heads/main`;
    requireOwnerMainActionsContext(env, recovery ? recoveryWorkflow : 'protected-int-passkey-bootstrap.yml');
    const request = json(env.CM_INT_PASSKEY_REQUEST_JSON);
    const checked = createPlatformPasskeyEnrollmentGrant({ ...request, issuedFromSessionId: null }).record;
    if (Object.hasOwn(request, 'issuedFromSessionId') || request.kind !== (recovery ? 'recovery' : 'bootstrap')
      || request.environment !== 'int' || request.ttlSeconds !== 900
      || checked.operatorId !== env.CM_INT_PASSKEY_OPERATOR_ID
      || String(checked.operatorSecurityVersion) !== env.CM_INT_PASSKEY_OPERATOR_VERSION
      || String(checked.securityEpoch) !== env.PLATFORM_SECURITY_EPOCH
      || checked.providerIdentity.tenantReference !== env.PLATFORM_OWNER_BOOTSTRAP_DIRECTORY_ID
      || checked.providerIdentity.subjectReference !== env.PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID) refuse();
    const evidence = json(env.CM_INT_PASSKEY_EVIDENCE);
    if (!evidence || Array.isArray(evidence) || Object.keys(evidence).sort().join(',') !==
      ['sourceSha','environment','deploymentEpoch','segmentId','operatorId','identityReference',
        'custodyReference','servicesClosed'].sort().join(',')
      || evidence.sourceSha !== env.GITHUB_SHA || evidence.environment !== 'int' || evidence.servicesClosed !== true
      || evidence.operatorId !== checked.operatorId || evidence.segmentId !== env.PLATFORM_AUDIT_SEGMENT_ID
      || evidence.deploymentEpoch !== env.PLATFORM_AUDIT_SEGMENT_DEPLOYMENT_EPOCH
      || !UUID.test(evidence.segmentId || '') || !UUID.test(evidence.deploymentEpoch || '')
      || [evidence.identityReference, evidence.custodyReference].some(value =>
        typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value))) refuse();
    const pem = env.CM_INT_PASSKEY_RECIPIENT_PUBLIC_KEY;
    if (typeof pem !== 'string' || pem.length > 900
      || !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/.test(pem)) refuse();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 4096
      || key.asymmetricKeyDetails.publicExponent !== 65537n) refuse();
    const fingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    if (fingerprint !== env.CM_INT_PASSKEY_RECIPIENT_SHA256) refuse();
    const label = Buffer.from(JSON.stringify([FORMAT, env.GITHUB_SHA, request.correlationId,
      checked.operatorId, checked.operatorSecurityVersion, 'int', checked.securityEpoch,
      evidence.segmentId, evidence.deploymentEpoch, fingerprint]));
    const encryption = { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label };
    // Prove recipient/configuration usability before any database write.
    publicEncrypt(encryption, Buffer.from('transport-preflight'));
    const binding = { operatorId: checked.operatorId, operatorSecurityVersion: checked.operatorSecurityVersion,
      providerIdentity: checked.providerIdentity, environment: 'int', securityEpoch: checked.securityEpoch };
    const browserFormat = 'cm-int-passkey-browser-delivery:v1';
    const browserLabel = createHash('sha256').update(Buffer.from(JSON.stringify([browserFormat,
      env.GITHUB_SHA, request.correlationId, checked.operatorId, checked.operatorSecurityVersion, 'int', checked.securityEpoch,
      evidence.segmentId, evidence.deploymentEpoch, fingerprint]))).digest();
    return Object.freeze({ request, encryptForBrowser(grant) {
      normalizePlatformPasskeyEnrollmentGrantClaim({ ...binding, ...grant });
      const bytes = Buffer.from(JSON.stringify(grant));
      try { return JSON.stringify({ format: browserFormat, requestId: request.correlationId, recipientSha256: fingerprint,
        labelHash: browserLabel.toString('hex'),
        ciphertext: publicEncrypt({ ...encryption, oaepLabel: browserLabel }, bytes).toString('base64url') }); }
      finally { bytes.fill(0); }
    }, encrypt(grant) {
      normalizePlatformPasskeyEnrollmentGrantClaim({ ...binding, ...grant });
      const bytes = Buffer.from(JSON.stringify(grant));
      try { return JSON.stringify({ format: FORMAT, ciphertext: publicEncrypt(encryption, bytes).toString('base64url') }); }
      finally { bytes.fill(0); }
    } });
  } catch { refuse(); }
}

// FD3 request and FD4 capability stay in private bounded child-process pipes.
export function collectPrivateBootstrapGrant(child, request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, settled = false;
    const clear = () => chunks.forEach(chunk => chunk.fill(0));
    const fail = () => {
      if (settled) return;
      settled = true; clear(); child.kill('SIGKILL');
      reject(new Error('PLATFORM_PASSKEY_BOOTSTRAP_DELIVERY_REFUSED'));
    };
    child.once('error', fail);
    child.stdio[3].on('error', fail);
    child.stdio[4].on('error', fail);
    child.stdio[4].on('data', chunk => {
      if (settled) { chunk.fill(0); return; }
      bytes += chunk.length;
      if (bytes > 1024) { chunk.fill(0); fail(); return; }
      chunks.push(chunk);
    });
    child.once('close', code => {
      if (settled) return;
      if (code !== 0 || bytes === 0) { fail(); return; }
      const buffer = Buffer.concat(chunks);
      try {
        const value = JSON.parse(buffer.toString('utf8'));
        if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'grantId,token') throw new Error();
        settled = true; resolve(value);
      } catch { fail(); }
      finally { buffer.fill(0); clear(); }
    });
    child.stdio[3].end(JSON.stringify(request));
  });
}
