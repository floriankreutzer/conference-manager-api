import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePlatformPrincipal, normalizeTrustedPlatformIdentity } from './principal.js';
import { permissionsForPlatformRoles } from './policy.js';
import { PlatformIdentityError } from './errors.js';
import { serializePlatformPasskeyTransactionCookie, clearPlatformPasskeyTransactionCookie } from './passkey-auth-cookie.js';
import { serializeClearedPlatformSessionCookie } from './session-cookie.js';

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const TTL_SECONDS = 120;
function reject() { throw new PlatformIdentityError('PLATFORM_PASSKEY_AUTHENTICATION_REJECTED'); }

export function createPlatformPasskeyAuthService({ repository, primaryOperatorService, verifier, sessionService,
  environment, securityEpoch, transactionSecret, tokenFactory = () => randomBytes(32).toString('base64url'),
  idFactory = () => randomUUID() } = {}) {
  if (!['create', 'findPending', 'listActiveCredentialIds', 'authenticate'].every(name => typeof repository?.[name] === 'function')) {
    throw new TypeError('PLATFORM_PASSKEY_AUTH_REPOSITORY_REQUIRED');
  }
  if (typeof primaryOperatorService?.resolve !== 'function') throw new TypeError('PLATFORM_PRIMARY_OPERATOR_SERVICE_REQUIRED');
  if (typeof verifier?.createChallenge !== 'function' || typeof verifier?.authenticationOptions !== 'function') {
    throw new TypeError('PLATFORM_PASSKEY_VERIFIER_REQUIRED');
  }
  if (!['issue', 'rotate', 'revoke', 'resolvePrincipal'].every(name => typeof sessionService?.[name] === 'function')) {
    throw new TypeError('PLATFORM_SESSION_SERVICE_REQUIRED');
  }
  if (!['dev', 'int', 'prod'].includes(environment) || !Number.isSafeInteger(securityEpoch) || securityEpoch < 1) {
    throw new TypeError('PLATFORM_PASSKEY_CONFIGURATION_INVALID');
  }
  const secret = Buffer.from(transactionSecret || '', 'utf8');
  if (secret.length < 32 || secret.length > 512) throw new TypeError('PLATFORM_PASSKEY_TRANSACTION_SECRET_INVALID');
  const mac = (domain, value, encoding = 'hex') => createHmac('sha256', secret)
    .update(`platform-passkey:v1:${environment}:${securityEpoch}:${domain}:${value}`, 'utf8').digest(encoding);
  function browser(state) { return mac('browser', state, 'base64url'); }
  function locator(cookie) {
    if (typeof cookie !== 'string' || cookie.length !== 87) reject();
    const [state, signature] = cookie.split('.');
    if (!OPAQUE.test(state || '') || !OPAQUE.test(signature || '')
      || !timingSafeEqual(Buffer.from(signature), Buffer.from(browser(state)))) reject();
    return { state, stateHash: mac('state', state), browserHash: mac('browser-proof', signature), environment, securityEpoch };
  }
  async function options(record) {
    const ids = await repository.listActiveCredentialIds({ operatorId: record.operatorId,
      operatorSecurityVersion: record.operatorSecurityVersion, environment });
    if (!ids.length) throw new PlatformIdentityError('PLATFORM_PASSKEY_ENROLLMENT_REQUIRED');
    return verifier.authenticationOptions({ challenge: record.challenge, allowedCredentialIds: ids });
  }
  async function start(binding, correlationId) {
    const state = tokenFactory();
    const id = idFactory();
    if (!OPAQUE.test(state || '') || !isInternalUuid(id) || !isInternalUuid(correlationId)) {
      throw new TypeError('PLATFORM_PASSKEY_FACTORY_INVALID');
    }
    const record = { ...binding, environment, securityEpoch, id, correlationId, ttlSeconds: TTL_SECONDS,
      stateHash: mac('state', state), browserHash: mac('browser-proof', browser(state)), challenge: verifier.createChallenge() };
    const authenticationOptions = await options(record);
    if (!await repository.create(record)) reject();
    return Object.freeze({ status: 'passkey_required', state, options: authenticationOptions,
      setCookie: serializePlatformPasskeyTransactionCookie(`${state}.${browser(state)}`, TTL_SECONDS) });
  }
  async function finish({ cookie, state, response, request } = {}, operationHash, mutation, invalidateSession = false) {
    const { state: expectedState, ...lookup } = locator(cookie);
    if (state !== expectedState) reject();
    const pending = await repository.findPending(lookup);
    if (!pending || (mutation ? pending.purpose !== 'step_up' || pending.operationHash !== operationHash
      : pending.purpose !== 'login')) reject();
    let current = null;
    if (mutation) {
      current = await sessionService.resolvePrincipal(request);
      if (!current || current.operatorId !== pending.operatorId || current.session.id !== pending.expectedSessionId
        || current.securityVersion !== pending.operatorSecurityVersion || current.session.securityEpoch !== securityEpoch) reject();
    }
    const { challenge, correlationId, ...binding } = pending;
    const verified = await repository.authenticate({ ...lookup, ...binding, response }, async proof => {
      const identity = normalizeTrustedPlatformIdentity({ operatorId: proof.operatorId,
        providerIdentity: proof.providerIdentity, roles: proof.roles, permissions: permissionsForPlatformRoles(proof.roles),
        securityVersion: proof.securityVersion, targetScope: { mode: proof.scopeMode, securityVersion: proof.securityVersion },
        assurance: { level: mutation ? 'step_up' : 'mfa',
          authenticationContext: 'cm:pk:v1', authenticatedAt: proof.authenticatedAt } });
      if (!mutation) return { issued: await sessionService.issue(identity, { correlationId: proof.correlationId }) };
      // The strongly verified session exists only inside this transaction. Its
      // cookie never leaves the server and cannot authorize a different action.
      const temporary = await sessionService.rotate(current, identity,
        { purpose: 'step_up', correlationId: proof.correlationId });
      const result = await mutation(Object.freeze({ principal: temporary.principal, operationHash }));
      if (result === null || result === undefined) throw new Error('PLATFORM_PASSKEY_MUTATION_REQUIRED');
      if (!await sessionService.revoke(temporary.principal, { correlationId: proof.correlationId })) reject();
      if (invalidateSession) return { result, issued: null };
      const normalIdentity = normalizeTrustedPlatformIdentity({ ...identity,
        assurance: { ...identity.assurance, level: 'mfa' } });
      return { result, issued: await sessionService.issue(normalIdentity, { correlationId: proof.correlationId }) };
    });
    if (!verified) reject();
    const { issued } = verified;
    if (!issued && invalidateSession) return Object.freeze({ status: 'reauthentication_required', result: verified.result,
      setCookies: Object.freeze([serializeClearedPlatformSessionCookie({ secure: true }), clearPlatformPasskeyTransactionCookie()]) });
    return Object.freeze({ status: mutation ? 'operation_completed' : 'authenticated',
      ...(mutation ? { result: verified.result } : {}), principal: issued.principal, csrfToken: issued.csrfToken,
      setCookies: Object.freeze([issued.setCookie, clearPlatformPasskeyTransactionCookie()]) });
  }
  return Object.freeze({
    async startLogin(assertion, { correlationId = idFactory() } = {}) {
      const primary = await primaryOperatorService.resolve(assertion, { correlationId });
      return start({ operatorId: primary.operatorId, operatorSecurityVersion: primary.securityVersion,
        purpose: 'login', expectedSessionId: null, operationHash: null }, correlationId);
    },
    async startStepUp(principalValue, { operationHash, correlationId = idFactory() } = {}) {
      const principal = normalizePlatformPrincipal(principalValue);
      if (principal.session.securityEpoch !== securityEpoch || !HASH.test(operationHash || '')) reject();
      return start({ operatorId: principal.operatorId, operatorSecurityVersion: principal.securityVersion,
        purpose: 'step_up', expectedSessionId: principal.session.id, operationHash }, correlationId);
    },
    async authenticationOptions(cookie) {
      const { state, ...lookup } = locator(cookie);
      const pending = await repository.findPending(lookup);
      if (!pending) reject();
      return Object.freeze({ state, options: await options(pending) });
    },
    async complete(input = {}) {
      return finish(input, null, null);
    },
    async executeStepUp(input, mutation) {
      if (typeof mutation !== 'function' || !HASH.test(input?.operationHash || '')) reject();
      return finish(input, input.operationHash, mutation);
    },
    async executeCredentialLifecycle(input, mutation) {
      if (typeof mutation !== 'function' || !HASH.test(input?.operationHash || '')) reject();
      return finish(input, input.operationHash, mutation, true);
    },
  });
}
