import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVIRONMENTS = new Set(['dev', 'int', 'prod']);
const KINDS = new Set(['bootstrap', 'recovery', 'additional']);

function invalid() { throw new TypeError('PLATFORM_PASSKEY_ENROLLMENT_GRANT_INVALID'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function provider(value) {
  exact(value, ['provider', 'tenantReference', 'subjectReference']);
  if (value.provider !== 'microsoft_entra_platform' || !GUID.test(value.tenantReference || '')
    || !GUID.test(value.subjectReference || '')) invalid();
  return Object.freeze({ provider: value.provider, tenantReference: value.tenantReference.toLowerCase(),
    subjectReference: value.subjectReference.toLowerCase() });
}
function binding(value) {
  if (!isInternalUuid(value.operatorId) || !Number.isSafeInteger(value.operatorSecurityVersion)
    || value.operatorSecurityVersion < 1 || !ENVIRONMENTS.has(value.environment)
    || !Number.isSafeInteger(value.securityEpoch) || value.securityEpoch < 1) invalid();
  return Object.freeze({ operatorId: value.operatorId.toLowerCase(), operatorSecurityVersion: value.operatorSecurityVersion,
    providerIdentity: provider(value.providerIdentity), environment: value.environment, securityEpoch: value.securityEpoch });
}
function token(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) invalid();
  return value;
}
function tokenHash(value, grantId, grantToken) {
  return createHash('sha256').update(JSON.stringify(['platform-passkey-enrollment:v1',
    value.environment, value.securityEpoch, value.operatorId, value.operatorSecurityVersion,
    value.providerIdentity.provider, value.providerIdentity.tenantReference,
    value.providerIdentity.subjectReference, grantId, token(grantToken)]), 'utf8').digest('hex');
}
const BINDING_KEYS = ['operatorId', 'operatorSecurityVersion', 'providerIdentity', 'environment', 'securityEpoch'];

export function normalizePlatformPasskeyEnrollmentBinding(value) {
  exact(value, BINDING_KEYS);
  return binding(value);
}

// A structurally valid record is not issuance authority. Only the independently
// authorized offline issuer or a verified operation-bound additional-key use case
// may persist it. Normal Microsoft primary authentication cannot issue a grant.
export function createPlatformPasskeyEnrollmentGrant(value, {
  idFactory = () => randomUUID(), tokenFactory = () => randomBytes(32).toString('base64url'),
} = {}) {
  exact(value, [...BINDING_KEYS, 'kind', 'approvalReference', 'issuedFromSessionId', 'ttlSeconds', 'correlationId']);
  const context = binding(value);
  if (!KINDS.has(value.kind) || typeof value.approvalReference !== 'string'
    || !/^[A-Z][A-Z0-9._:-]{3,127}$/.test(value.approvalReference) || !isInternalUuid(value.correlationId)
    || !Number.isInteger(value.ttlSeconds) || value.ttlSeconds < 60
    || value.ttlSeconds > (value.kind === 'additional' ? 300 : 900)
    || (value.kind === 'additional' ? !isInternalUuid(value.issuedFromSessionId) : value.issuedFromSessionId !== null)) invalid();
  const generatedId = idFactory();
  if (!isInternalUuid(generatedId)) invalid();
  const id = generatedId.toLowerCase();
  const grantToken = token(tokenFactory());
  return Object.freeze({
    record: Object.freeze({ ...context, id, kind: value.kind, approvalReference: value.approvalReference,
      issuedFromSessionId: value.issuedFromSessionId?.toLowerCase() ?? null, ttlSeconds: value.ttlSeconds,
      correlationId: value.correlationId.toLowerCase(), tokenHash: tokenHash(context, id, grantToken) }),
    grant: Object.freeze({ grantId: id, token: grantToken }),
  });
}

export function normalizePlatformPasskeyEnrollmentGrantClaim(value) {
  exact(value, [...BINDING_KEYS, 'grantId', 'token']);
  const context = binding(value);
  if (!isInternalUuid(value.grantId)) invalid();
  const grantId = value.grantId.toLowerCase();
  return Object.freeze({ ...context, grantId, tokenHash: tokenHash(context, grantId, value.token) });
}
