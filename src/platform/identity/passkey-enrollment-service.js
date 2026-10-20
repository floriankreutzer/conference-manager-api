import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformIdentityError } from './errors.js';
import { normalizePlatformPasskeyEnrollmentGrantClaim } from './passkey-enrollment-grant.js';
import { serializePlatformPasskeyEnrollmentCookie, clearPlatformPasskeyEnrollmentCookie } from './passkey-enrollment-cookie.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TTL_SECONDS = 120;
function reject() { throw new PlatformIdentityError('PLATFORM_PASSKEY_ENROLLMENT_REJECTED'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) reject();
}
function opaque(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)
    || Buffer.from(value, 'base64url').toString('base64url') !== value) reject();
  return value;
}

// Inactive application port. Its durable repository must lock current operator,
// grant and ceremony authority, enforce DB-clock expiry/attempt limits, and commit
// grant redemption, possession proof, credential insert/version invalidation and
// audit together. A registration response must never insert an active credential.
export function createPlatformPasskeyEnrollmentService({ repository, primaryOperatorService, verifier,
  environment, securityEpoch, tokenFactory = () => randomBytes(32).toString('base64url'),
  idFactory = () => randomUUID() } = {}) {
  if (!['begin', 'findRegistration', 'stageCredential', 'complete'].every(name => typeof repository?.[name] === 'function')) {
    throw new TypeError('PLATFORM_PASSKEY_ENROLLMENT_REPOSITORY_REQUIRED');
  }
  if (typeof primaryOperatorService?.resolve !== 'function') throw new TypeError('PLATFORM_PRIMARY_OPERATOR_SERVICE_REQUIRED');
  if (!['createChallenge', 'registrationOptions', 'verifyRegistration', 'authenticationOptions', 'verifyAuthentication']
    .every(name => typeof verifier?.[name] === 'function')) throw new TypeError('PLATFORM_PASSKEY_VERIFIER_REQUIRED');
  if (!['dev', 'int', 'prod'].includes(environment) || !Number.isSafeInteger(securityEpoch) || securityEpoch < 1) {
    throw new TypeError('PLATFORM_PASSKEY_CONFIGURATION_INVALID');
  }
  const hash = (purpose, value) => createHash('sha256').update(JSON.stringify([
    'platform-passkey-enrollment:v1', environment, securityEpoch, purpose, value,
  ])).digest('hex');
  function locator(cookie) {
    if (typeof cookie !== 'string' || cookie.length !== 87) reject();
    const [state, browser] = cookie.split('.');
    opaque(state); opaque(browser);
    return { state, stateHash: hash('state', state), browserHash: hash('browser', browser), environment, securityEpoch };
  }
  function request(value) {
    exact(value, ['cookie', 'state', 'response']);
    const { state, ...lookup } = locator(value.cookie);
    if (value.state !== state) reject();
    return { ...lookup, response: value.response };
  }
  async function registration(record) {
    if (!record) reject();
    return verifier.registrationOptions({ challenge: record.registrationChallenge, userHandle: record.userHandle,
      userName: 'Conference Manager operator', excludeCredentialIds: record.excludeCredentialIds });
  }
  return Object.freeze({
    async start(value) {
      exact(value, ['assertion', 'grant', 'correlationId']);
      exact(value.grant, ['grantId', 'token']);
      if (!isInternalUuid(value.correlationId)) reject();
      const primary = await primaryOperatorService.resolve(value.assertion, { correlationId: value.correlationId });
      // All identity/epoch authority comes from verified primary context and
      // server configuration. Browser input supplies only the opaque grant.
      const claim = normalizePlatformPasskeyEnrollmentGrantClaim({ ...value.grant, environment, securityEpoch,
        operatorId: primary.operatorId, operatorSecurityVersion: primary.securityVersion, providerIdentity: primary.providerIdentity });
      const state = opaque(tokenFactory()); const browser = opaque(tokenFactory()); const id = idFactory();
      if (!isInternalUuid(id) || state === browser) reject();
      const registrationChallenge = opaque(verifier.createChallenge());
      const possessionChallenge = opaque(verifier.createChallenge());
      if (registrationChallenge === possessionChallenge) reject();
      const record = await repository.begin({ ...claim, id, stateHash: hash('state', state), browserHash: hash('browser', browser),
        registrationChallenge, possessionChallenge,
        correlationId: value.correlationId, ttlSeconds: TTL_SECONDS });
      const options = await registration(record);
      return Object.freeze({ status: 'registration_required', state, options,
        setCookie: serializePlatformPasskeyEnrollmentCookie(`${state}.${browser}`, TTL_SECONDS) });
    },
    async registrationOptions(cookie) {
      const { state, ...lookup } = locator(cookie);
      return Object.freeze({ state, options: await registration(await repository.findRegistration(lookup)) });
    },
    async pending(cookie) {
      const { state, ...lookup } = locator(cookie);
      const record = await repository.findRegistration(lookup);
      if (record) return Object.freeze({ status: 'registration_required', state, options: await registration(record) });
      if (typeof repository.findPossession !== 'function') reject();
      const staged = await repository.findPossession(lookup);
      if (!staged) reject();
      return Object.freeze({ status: 'possession_required', state, options: await verifier.authenticationOptions({
        challenge: staged.possessionChallenge, allowedCredentialIds: [staged.credentialId] }) });
    },
    async register(value) {
      const pending = await repository.stageCredential(request(value), async record => verifier.verifyRegistration({
        response: value.response, expectedChallenge: record.registrationChallenge,
      }));
      if (!pending) reject();
      const options = await verifier.authenticationOptions({ challenge: pending.possessionChallenge,
        allowedCredentialIds: [pending.credentialId] });
      return Object.freeze({ status: 'possession_required', state: value.state, options });
    },
    async complete(value) {
      const enrolled = await repository.complete(request(value), async record => verifier.verifyAuthentication({
        response: value.response, expectedChallenge: record.possessionChallenge,
        expectedOperatorId: record.operatorId, credential: record.credential,
      }));
      if (enrolled !== true) reject();
      // Enrollment invalidates prior authority. A new Microsoft + passkey login
      // is required; this use case has no session issuance capability.
      return Object.freeze({ status: 'credential_enrolled', setCookie: clearPlatformPasskeyEnrollmentCookie() });
    },
  });
}
