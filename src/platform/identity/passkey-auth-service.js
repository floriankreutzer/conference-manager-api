import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePlatformPrincipal, normalizeTrustedPlatformIdentity } from './principal.js';
import { permissionsForPlatformRoles } from './policy.js';
import { requirePlatformPasskeyMinimum } from './passkey-policy.js';
import { PlatformIdentityError } from './errors.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { serializePlatformPasskeyTransactionCookie, clearPlatformPasskeyTransactionCookie } from './passkey-auth-cookie.js';
import { serializeClearedPlatformSessionCookie } from './session-cookie.js';
import { PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME, serializePlatformPasskeyEnrollmentCookie } from './passkey-enrollment-cookie.js';

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const TTL_SECONDS = 120;
function reject() { throw new PlatformIdentityError('PLATFORM_PASSKEY_AUTHENTICATION_REJECTED'); }
function identityForProof(proof, level) {
  return normalizeTrustedPlatformIdentity({ operatorId: proof.operatorId,
    providerIdentity: proof.providerIdentity, roles: proof.roles, permissions: permissionsForPlatformRoles(proof.roles),
    securityVersion: proof.securityVersion, targetScope: { mode: proof.scopeMode, securityVersion: proof.securityVersion },
    assurance: { level, authenticationContext: 'cm:pk:v1', authenticatedAt: proof.authenticatedAt } });
}

export function createPlatformPasskeyAuthService({ repository, primaryOperatorService, verifier, sessionService,
  environment, securityEpoch, transactionSecret, tokenFactory = () => randomBytes(32).toString('base64url'),
  idFactory = () => randomUUID(), allowBusinessLogin = true, minimumCredentialCount = 2 } = {}) {
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
  requirePlatformPasskeyMinimum(environment,minimumCredentialCount);
  const secret = Buffer.from(transactionSecret || '', 'utf8');
  if (typeof allowBusinessLogin !== 'boolean' || ![1, 2].includes(minimumCredentialCount)) {
    throw new TypeError('PLATFORM_PASSKEY_LOGIN_POLICY_INVALID');
  }
  if (secret.length < 32 || secret.length > 512) throw new TypeError('PLATFORM_PASSKEY_TRANSACTION_SECRET_INVALID');
  const mac = (domain, value, encoding = 'hex') => createHmac('sha256', secret)
    .update(`platform-passkey:v1:${environment}:${securityEpoch}:${domain}:${value}`, 'utf8').digest(encoding);
  const operationContexts = new WeakMap();
  const operationContinuations = new WeakMap();
  function verifiedContext(context,operationHash,requiresContinuation=false) {
    const verified=operationContexts.get(context),continuationPrincipal=operationContinuations.get(context);
    operationContexts.delete(context);operationContinuations.delete(context);
    if (!verified || verified.operationHash!==operationHash || requiresContinuation && !continuationPrincipal) reject();
    return Object.freeze({ principal: verified.principal,continuationPrincipal: continuationPrincipal ?? null });
  }
  function browser(state) { return mac('browser', state, 'base64url'); }
  function locator(cookie) {
    if (typeof cookie !== 'string' || cookie.length !== 87) reject();
    const [state, signature] = cookie.split('.');
    if (!OPAQUE.test(state || '') || !OPAQUE.test(signature || '')
      || !timingSafeEqual(Buffer.from(signature), Buffer.from(browser(state)))) reject();
    return { state, stateHash: mac('state', state), browserHash: mac('browser-proof', signature), environment, securityEpoch };
  }
  async function activeIds(record) {
    return [...new Set(await repository.listActiveCredentialIds({ operatorId: record.operatorId,
      operatorSecurityVersion: record.operatorSecurityVersion, environment }))];
  }
  async function options(record, ids = null) {
    ids ??= await activeIds(record);
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
    const ids = await activeIds(record);
    const enrolling = ids.length === 0 && binding.purpose === 'login';
    if (enrolling) record.purpose = 'enroll';
    else delete record.primaryAuthenticatedAt;
    const authenticationOptions = enrolling ? null : await options(record, ids);
    if (!await repository.create(record)) reject();
    return Object.freeze({ status: enrolling ? 'enrollment_required' : 'passkey_required', state,
      ...(enrolling ? {} : { options: authenticationOptions }),
      setCookie: serializePlatformPasskeyTransactionCookie(`${state}.${browser(state)}`, TTL_SECONDS) });
  }
  async function finish({ cookie, state, response, request } = {}, operationHash, mutation,
    invalidateSession = false,requiresContinuation = false) {
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
      const identity = identityForProof(proof, mutation ? 'step_up' : 'mfa');
      if (!mutation) {
        if (!allowBusinessLogin || (await activeIds({ operatorId: proof.operatorId,
          operatorSecurityVersion: proof.securityVersion })).length < minimumCredentialCount) {
          throw new PlatformIdentityError('PLATFORM_PASSKEY_SETUP_REQUIRED');
        }
        return { issued: await sessionService.issue(identity, { correlationId: proof.correlationId }) };
      }
      if (requiresContinuation && new Set(await activeIds({ operatorId: proof.operatorId,
        operatorSecurityVersion: proof.securityVersion })).size<2) {
        throw new PlatformIdentityError('PLATFORM_PASSKEY_SETUP_REQUIRED');
      }
      // The strongly verified session exists only inside this transaction. Its
      // cookie never leaves the server and cannot authorize a different action.
      const temporary = await sessionService.rotate(current, identity,
        { purpose: 'step_up', correlationId: proof.correlationId });
      const normalIdentity = normalizeTrustedPlatformIdentity({ ...identity,
        assurance: { ...identity.assurance, level: 'mfa' } });
      // Only the explicit continuation flow issues its future normal session
      // before mutation, inside the same proof transaction. Its cookie remains
      // private until commit. The old and temporary sessions cannot back handoff.
      const continuation=requiresContinuation
        ? await sessionService.issue(normalIdentity,{ correlationId: proof.correlationId }) : null;
      let continuationPrincipal=null;
      if (continuation) {
        continuationPrincipal=normalizePlatformPrincipal(continuation.principal);
        const temporaryPrincipal=normalizePlatformPrincipal(temporary.principal);
        if (continuationPrincipal.operatorId!==identity.operatorId || continuationPrincipal.securityVersion!==identity.securityVersion
          || continuationPrincipal.session.securityEpoch!==securityEpoch || continuationPrincipal.assurance.level!=='mfa'
          || continuationPrincipal.assurance.authenticationContext!=='cm:pk:v1'
          || continuationPrincipal.assurance.authenticatedAt!==identity.assurance.authenticatedAt
          || continuationPrincipal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER
          || ['provider','tenantReference','subjectReference'].some(key=>
            continuationPrincipal.providerIdentity[key]!==identity.providerIdentity[key])
          || [current.session.id,temporaryPrincipal.session.id].includes(continuationPrincipal.session.id)) reject();
      }
      const context = Object.freeze({ principal: temporary.principal, operationHash });
      operationContexts.set(context, context);
      if (continuation) operationContinuations.set(context,continuationPrincipal);
      let result;
      try { result = await mutation(context); }
      finally { operationContexts.delete(context);operationContinuations.delete(context); }
      if (result === null || result === undefined) throw new Error('PLATFORM_PASSKEY_MUTATION_REQUIRED');
      if (!await sessionService.revoke(temporary.principal, { correlationId: proof.correlationId })) reject();
      if (invalidateSession) return { result, issued: null };
      return { result, issued: continuation ?? await sessionService.issue(normalIdentity, { correlationId: proof.correlationId }) };
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
        purpose: 'login', expectedSessionId: null, operationHash: null,
        primaryAuthenticatedAt: primary.primaryAuthenticatedAt }, correlationId);
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
    async pendingAuthentication(cookie) {
      const { state, ...lookup } = locator(cookie);
      const pending = await repository.findPending(lookup);
      if (!pending) reject();
      if (pending.purpose === 'enroll') return Object.freeze({ status: 'enrollment_required', state });
      const ids = await activeIds(pending);
      return Object.freeze({ status: 'passkey_required', state, options: await options(pending, ids),
        setupRequired: pending.purpose === 'login' && (!allowBusinessLogin || ids.length < minimumCredentialCount) });
    },
    async consumeEnrollmentPrimary({ cookie, state } = {}, onResolved) {
      if (typeof repository.consumeEnrollmentPrimary !== 'function' || typeof onResolved !== 'function') reject();
      const { state: expected, ...lookup } = locator(cookie);
      if (state !== expected) reject();
      const result = await repository.consumeEnrollmentPrimary(lookup, onResolved);
      if (!result) reject();
      return result;
    },
    async executeSetupLogin({ cookie, state, response } = {}, mutation) {
      if (typeof mutation !== 'function') reject();
      const { state: expected, ...lookup } = locator(cookie);
      if (state !== expected) reject();
      const pending = await repository.findPending(lookup);
      if (!pending || pending.purpose !== 'login') reject();
      const { challenge, correlationId, ...binding } = pending;
      const result = await repository.authenticate({ ...lookup, ...binding, response }, async proof => {
        const ids = await activeIds({ operatorId: proof.operatorId, operatorSecurityVersion: proof.securityVersion });
        if (ids.length >= minimumCredentialCount) {
          return Object.freeze({ status: 'setup_complete', setCookie: clearPlatformPasskeyTransactionCookie() });
        }
        if (ids.length !== 1) reject();
        const temporary = await sessionService.issue(identityForProof(proof, 'step_up'), { correlationId: proof.correlationId });
        const next = await mutation(Object.freeze({ principal: temporary.principal, correlationId: proof.correlationId }));
        if (!next || Object.keys(next).sort().join(',') !== 'options,setCookie,state,status'
          || next.status !== 'registration_required' || !OPAQUE.test(next.state || '')
          || typeof next.setCookie !== 'string'
          || !next.setCookie.startsWith(`${PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME}=${next.state}.`)
          || typeof next.options !== 'object' || next.options === null) reject();
        const value = next.setCookie.split(';')[0].slice(PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME.length + 1);
        if (next.setCookie !== serializePlatformPasskeyEnrollmentCookie(value, TTL_SECONDS)) reject();
        if (!await sessionService.revoke(temporary.principal, { correlationId: proof.correlationId })) reject();
        return next;
      });
      if (!result) reject();
      return result;
    },
    async executeStepUp(input, mutation) {
      if (typeof mutation !== 'function' || !HASH.test(input?.operationHash || '')) reject();
      return finish(input, input.operationHash, mutation);
    },
    async executeStepUpWithContinuation(input,mutation) {
      if (typeof mutation!=='function' || !HASH.test(input?.operationHash || '')) reject();
      if (!allowBusinessLogin || minimumCredentialCount!==2) throw new PlatformIdentityError('PLATFORM_PASSKEY_SETUP_REQUIRED');
      return finish(input,input.operationHash,mutation,false,true);
    },
    async executeCredentialLifecycle(input, mutation) {
      if (typeof mutation !== 'function' || !HASH.test(input?.operationHash || '')) reject();
      return finish(input, input.operationHash, mutation, true);
    },
    verifiedOperationPrincipal(context, operationHash) {
      return verifiedContext(context,operationHash).principal;
    },
    verifiedOperationWithContinuation(context,operationHash) {
      return verifiedContext(context,operationHash,true);
    },
  });
}
