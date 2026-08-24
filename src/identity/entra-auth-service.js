import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';
import { EntraAuthenticationError } from './entra-errors.js';
import { ENTRA_IDENTITY_PROVIDER } from './entra-client.js';
import {
  ENTRA_TRANSACTION_COOKIE_PATTERN,
  serializeClearedEntraTransactionCookie,
  serializeEntraTransactionCookie,
} from './entra-transaction-cookie.js';

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~-]{1,4096}$/;
const DEFAULT_TRANSACTION_TTL_SECONDS = 600;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pkceVerifier(secret, state) {
  return createHmac('sha256', secret).update(`pkce:${state}`, 'utf8').digest('base64url');
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function browserBinding(secret, state) {
  return createHmac('sha256', secret).update(`browser:${state}`, 'utf8').digest('base64url');
}

function normalizeTransactionSecret(value) {
  const secret = Buffer.from(value || '', 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) throw new TypeError('OIDC_TRANSACTION_SECRET_INVALID');
  return secret;
}

function requireState(value) {
  if (typeof value !== 'string' || !STATE_PATTERN.test(value)) {
    throw new EntraAuthenticationError('OIDC_STATE_INVALID');
  }
  return value;
}

function requireCode(value) {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new EntraAuthenticationError('OIDC_CODE_INVALID');
  }
  return value;
}

function validateOnboardingInvitationId(value) {
  if (value !== null && !isInternalUuid(value)) {
    throw new TypeError('OIDC_ONBOARDING_INVITATION_INVALID');
  }
  return value;
}

function safeTokenEqual(left, right) {
  if (
    typeof left !== 'string'
    || typeof right !== 'string'
    || !ENTRA_TRANSACTION_COOKIE_PATTERN.test(left)
    || !ENTRA_TRANSACTION_COOKIE_PATTERN.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

function validateIdentityResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('IDENTITY_RESOLUTION_INVALID');
  }
  if (value.status === 'onboarding_required') {
    return Object.freeze({ status: 'onboarding_required' });
  }
  if (value.status === 'claim_confirmation_required' && typeof value.setCookie === 'string') {
    return Object.freeze({ status: 'claim_confirmation_required', setCookie: value.setCookie });
  }
  if (value.status === 'authenticated' && value.trustedIdentity) {
    return Object.freeze({ status: 'authenticated', trustedIdentity: value.trustedIdentity });
  }
  throw new TypeError('IDENTITY_RESOLUTION_INVALID');
}

export function createEntraAuthService({
  repository,
  entraClient,
  identityResolver,
  sessionService,
  transactionSecret,
  publicOrigin,
  transactionTtlSeconds = DEFAULT_TRANSACTION_TTL_SECONDS,
  clock = () => Date.now(),
  randomToken = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (!repository || typeof repository.create !== 'function' || typeof repository.consume !== 'function') {
    throw new TypeError('OIDC_TRANSACTION_REPOSITORY_REQUIRED');
  }
  if (!entraClient || typeof entraClient.authorizationUrl !== 'function' || typeof entraClient.redeemAuthorizationCode !== 'function') {
    throw new TypeError('ENTRA_CLIENT_REQUIRED');
  }
  if (!identityResolver || typeof identityResolver.resolve !== 'function') throw new TypeError('IDENTITY_RESOLVER_REQUIRED');
  if (!sessionService || typeof sessionService.issue !== 'function') throw new TypeError('SESSION_SERVICE_REQUIRED');
  if (typeof publicOrigin !== 'string') throw new TypeError('PUBLIC_ORIGIN_REQUIRED');
  const secureCookie = new URL(publicOrigin).protocol === 'https:';
  if (!Number.isSafeInteger(transactionTtlSeconds) || transactionTtlSeconds < 120 || transactionTtlSeconds > 900) {
    throw new TypeError('OIDC_TRANSACTION_TTL_INVALID');
  }
  const secret = normalizeTransactionSecret(transactionSecret);

  return Object.freeze({
    async start({ correlationId, onboardingInvitationId = null } = {}) {
      const state = requireState(randomToken());
      const nonce = requireState(randomToken());
      validateOnboardingInvitationId(onboardingInvitationId);
      const nowMs = clock();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('OIDC_CLOCK_INVALID');
      const createdAt = new Date(nowMs);
      const expiresAt = new Date(nowMs + (transactionTtlSeconds * 1000));
      await repository.create({
        provider: ENTRA_IDENTITY_PROVIDER,
        stateHash: sha256Hex(state),
        nonceHash: sha256Hex(nonce),
        onboardingInvitationId,
        createdAt,
        expiresAt,
        correlationId,
      });
      const verifier = pkceVerifier(secret, state);
      const authorizationUrl = await entraClient.authorizationUrl({
        state,
        nonce,
        codeChallenge: pkceChallenge(verifier),
      });
      return Object.freeze({
        authorizationUrl,
        setCookie: serializeEntraTransactionCookie(browserBinding(secret, state), {
          secure: secureCookie,
          maxAgeSeconds: transactionTtlSeconds,
        }),
      });
    },

    async complete({ state: stateValue, code: codeValue, providerError, browserBinding: presentedBinding, correlationId } = {}) {
      const state = requireState(stateValue);
      if (!safeTokenEqual(presentedBinding, browserBinding(secret, state))) {
        throw new EntraAuthenticationError('OIDC_BROWSER_BINDING_INVALID');
      }
      const nowMs = clock();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('OIDC_CLOCK_INVALID');
      const transaction = await repository.consume({
        provider: ENTRA_IDENTITY_PROVIDER,
        stateHash: sha256Hex(state),
        consumedAt: new Date(nowMs),
      });
      if (!transaction) throw new EntraAuthenticationError('OIDC_STATE_INVALID');

      if (providerError) return Object.freeze({ status: 'authentication_rejected' });

      const code = requireCode(codeValue);
      const verifier = pkceVerifier(secret, state);
      const externalIdentity = await entraClient.redeemAuthorizationCode({
        code,
        codeVerifier: verifier,
        expectedNonceHash: transaction.nonceHash,
      });
      const resolution = validateIdentityResolution(await identityResolver.resolve(externalIdentity, {
        correlationId,
        onboardingInvitationId: transaction.onboardingInvitationId,
      }));
      if (resolution.status === 'onboarding_required' || resolution.status === 'claim_confirmation_required') {
        return resolution;
      }

      const issued = await sessionService.issue(resolution.trustedIdentity, { correlationId });
      return Object.freeze({
        status: 'authenticated',
        principal: issued.principal,
        setCookie: issued.setCookie,
      });
    },

    clearCookie() {
      return serializeClearedEntraTransactionCookie({ secure: secureCookie });
    },
  });
}

export function secureStateHashEquals(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left || '') || !/^[0-9a-f]{64}$/.test(right || '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
