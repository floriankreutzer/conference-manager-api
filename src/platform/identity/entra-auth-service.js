import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { PLATFORM_ENTRA_PROVIDER } from './entra-client.js';
import { PLATFORM_AUDIT_ACTION } from '../audit/event.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import {
  PLATFORM_ENTRA_TRANSACTION_COOKIE_PATTERN,
  serializeClearedPlatformEntraTransactionCookie,
  serializePlatformEntraTransactionCookie,
} from './entra-transaction-cookie.js';
import { PlatformIdentityError } from './errors.js';
import { normalizePlatformPrincipal } from './principal.js';

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~-]{1,4096}$/;
const PROVIDER_ERROR_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const DEFAULT_TTL_SECONDS = 600;

const REDEMPTION_FAILURE_REASONS = Object.freeze({
  PLATFORM_ENTRA_CODE_REDEMPTION_FAILED: 'provider_code_exchange_failed',
  PLATFORM_ENTRA_CLAIMS_INVALID: 'provider_claims_invalid',
  PLATFORM_ENTRA_TENANT_INVALID: 'provider_tenant_invalid',
  PLATFORM_OPERATOR_TENANT_MISMATCH: 'provider_tenant_mismatch',
  PLATFORM_ENTRA_SUBJECT_INVALID: 'provider_subject_invalid',
  PLATFORM_AUDIENCE_MISMATCH: 'provider_audience_mismatch',
  PLATFORM_ISSUER_MISMATCH: 'provider_issuer_mismatch',
  PLATFORM_ENTRA_NONCE_INVALID: 'provider_nonce_invalid',
  PLATFORM_ENTRA_TOKEN_EXPIRED: 'provider_token_expired',
  PLATFORM_ENTRA_ISSUED_AT_INVALID: 'provider_issued_at_invalid',
  PLATFORM_ENTRA_AUTHENTICATION_TIME_INVALID: 'provider_authentication_time_invalid',
  PLATFORM_ENTRA_AUTHENTICATION_NOT_FRESH: 'provider_authentication_not_fresh',
  PLATFORM_ENTRA_NOT_YET_VALID: 'provider_not_yet_valid',
  PLATFORM_ENTRA_TOKEN_VERSION_INVALID: 'provider_token_version_invalid',
  PLATFORM_ENTRA_TOKEN_TIME_INVALID: 'provider_token_time_invalid',
  PLATFORM_ENTRA_TOKEN_LIFETIME_INVALID: 'provider_token_lifetime_invalid',
  PLATFORM_ENTRA_ISSUED_AT_NEGATIVE: 'provider_issued_at_negative',
  PLATFORM_ENTRA_AUTHENTICATION_TIME_NEGATIVE: 'provider_authentication_time_negative',
  PLATFORM_ENTRA_TOKEN_EXPIRY_ORDER_INVALID: 'provider_token_expiry_order_invalid',
  PLATFORM_ENTRA_AUTHENTICATION_ORDER_INVALID: 'provider_authentication_order_invalid',
  PLATFORM_ENTRA_ISSUED_AT_NOT_FRESH: 'provider_issued_at_not_fresh',
  PLATFORM_ENTRA_AUTHENTICATION_EXPIRY_ORDER_INVALID: 'provider_authentication_expiry_order_invalid',
  PLATFORM_PRIMARY_CODE_INPUT_INVALID: 'provider_code_input_invalid',
  PLATFORM_ASSURANCE_CONTEXT_REJECTED: 'provider_assurance_context_rejected',
});

function redemptionFailureReason(error) {
  if (!(error instanceof PlatformIdentityError) || !Object.hasOwn(REDEMPTION_FAILURE_REASONS, error.code)) {
    return 'provider_redeem_failed';
  }
  return REDEMPTION_FAILURE_REASONS[error.code];
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(secret, domain, state) {
  return createHmac('sha256', secret).update(`${domain}:${state}`, 'utf8').digest('base64url');
}

function safeEqual(left, right) {
  if (
    typeof left !== 'string'
    || typeof right !== 'string'
    || !PLATFORM_ENTRA_TRANSACTION_COOKIE_PATTERN.test(left)
    || !PLATFORM_ENTRA_TRANSACTION_COOKIE_PATTERN.test(right)
  ) return false;
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

function exactHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('PLATFORM_PUBLIC_ORIGIN_INVALID');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.origin !== value
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) throw new TypeError('PLATFORM_PUBLIC_ORIGIN_INVALID');
}

function opaque(value, code) {
  if (!OPAQUE_PATTERN.test(value || '')) throw new PlatformIdentityError(code);
  return value;
}

function code(value) {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new PlatformIdentityError('PLATFORM_OIDC_CODE_INVALID');
  }
  return value;
}

function createAuthService({
  repository,
  entraClient,
  identityService,
  sessionService,
  passkeyAuthService,
  auditService,
  transactionSecret,
  publicOrigin,
  securityEpoch,
  mfaAuthenticationContext,
  stepUpAuthenticationContext,
  transactionTtlSeconds = DEFAULT_TTL_SECONDS,
  randomToken = () => randomBytes(32).toString('base64url'),
  idFactory = () => randomUUID(),
} = {}, primaryOnly = false,loginOnly=false) {
  if (!repository || typeof repository.create !== 'function' || typeof repository.consume !== 'function') {
    throw new TypeError('PLATFORM_OIDC_TRANSACTION_REPOSITORY_REQUIRED');
  }
  if (
    !entraClient
    || typeof entraClient.authorizationUrl !== 'function'
    || typeof entraClient.redeemAuthorizationCode !== 'function'
  ) throw new TypeError('PLATFORM_ENTRA_CLIENT_REQUIRED');
  if (!primaryOnly && (!identityService || typeof identityService.verify !== 'function')) {
    throw new TypeError('PLATFORM_IDENTITY_SERVICE_REQUIRED');
  }
  if (!primaryOnly && (
    !sessionService
    || typeof sessionService.issue !== 'function'
    || typeof sessionService.rotate !== 'function'
    || typeof sessionService.resolvePrincipal !== 'function'
  )) throw new TypeError('PLATFORM_SESSION_SERVICE_REQUIRED');
  if (
    !auditService
    || typeof auditService.createUnmappedAuthenticationFailure !== 'function'
    || (!primaryOnly && typeof auditService.createDeniedEvent !== 'function')
    || typeof auditService.record !== 'function'
  ) throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');
  exactHttpsOrigin(publicOrigin);
  if (!Number.isSafeInteger(securityEpoch) || securityEpoch < 1) {
    throw new TypeError('PLATFORM_SESSION_EPOCH_INVALID');
  }
  if (!Number.isSafeInteger(transactionTtlSeconds) || transactionTtlSeconds < 120 || transactionTtlSeconds > (primaryOnly ? 300 : 600)) {
    throw new TypeError('PLATFORM_OIDC_TTL_INVALID');
  }
  if (!primaryOnly && (
    typeof mfaAuthenticationContext !== 'string'
    || typeof stepUpAuthenticationContext !== 'string'
    || mfaAuthenticationContext === stepUpAuthenticationContext
  )) throw new TypeError('PLATFORM_OIDC_AUTHENTICATION_CONTEXT_INVALID');
  if (primaryOnly && (typeof entraClient.verifyPrimary !== 'function'
    || typeof passkeyAuthService?.startLogin !== 'function'
    || mfaAuthenticationContext !== undefined || stepUpAuthenticationContext !== undefined)) {
    throw new TypeError('PLATFORM_PRIMARY_FLOW_CONFIGURATION_INVALID');
  }
  const secret = Buffer.from(transactionSecret || '', 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) {
    throw new TypeError('PLATFORM_OIDC_TRANSACTION_SECRET_INVALID');
  }

  async function recordFailure(reasonCode, correlationId) {
    await auditService.record(auditService.createUnmappedAuthenticationFailure({
      correlationId,
      reasonCode,
    }));
  }

  async function recordStepUpDenied(principal, reasonCode, correlationId) {
    await auditService.record(auditService.createDeniedEvent({
      principal,
      correlationId,
      action: PLATFORM_AUDIT_ACTION.AUTHORIZATION_DENIED,
      targetType: 'platform_operator',
      targetId: principal.operatorId,
      metadata: { reasonCode },
    }));
  }

  return Object.freeze({
    async start({ purpose = 'login', principal: principalValue = null, correlationId } = {}) {
      if (((primaryOnly || loginOnly) && purpose !== 'login') || !['login', 'step_up'].includes(purpose)) {
        throw new TypeError('PLATFORM_OIDC_PURPOSE_INVALID');
      }
      let principal = null;
      if (purpose === 'step_up') principal = normalizePlatformPrincipal(principalValue);
      if (purpose === 'login' && principalValue !== null) throw new TypeError('PLATFORM_OIDC_LOGIN_PRINCIPAL_FORBIDDEN');
      const state = opaque(randomToken(), 'PLATFORM_OIDC_STATE_FACTORY_INVALID');
      const nonce = hmac(secret,'platform-oidc-nonce:v1',state);
      const authenticationContext = primaryOnly ? 'cm:pk:primary:v1'
        : purpose === 'step_up' ? stepUpAuthenticationContext : mfaAuthenticationContext;
      const flowCorrelationId = correlationId === undefined ? idFactory() : correlationId;
      if (!isInternalUuid(flowCorrelationId)) throw new TypeError('PLATFORM_OIDC_CORRELATION_ID_INVALID');
      await repository.create({
        stateHash: sha256(state),
        nonceHash: sha256(nonce),
        purpose,
        expectedOperatorId: principal?.operatorId || null,
        expectedSessionId: principal?.session.id || null,
        expectedSecurityVersion: principal?.securityVersion || null,
        securityEpoch,
        authenticationContext,
        ttlSeconds: transactionTtlSeconds,
        correlationId: flowCorrelationId,
      });
      const verifier = hmac(secret, 'platform-pkce', state);
      const authorizationUrl = await entraClient.authorizationUrl({
        state,
        nonce,
        codeChallenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
        ...(!primaryOnly ? { authenticationContext } : {}),
      });
      return Object.freeze({
        authorizationUrl,
        setCookie: serializePlatformEntraTransactionCookie(
          hmac(secret, 'platform-browser', state),
          { maxAgeSeconds: transactionTtlSeconds },
        ),
      });
    },

    async complete({
      request,
      state: stateValue,
      code: codeValue,
      providerError = null,
      browserBinding,
      correlationId,
    } = {}) {
      let state;
      try {
        state = opaque(stateValue, 'PLATFORM_OIDC_STATE_INVALID');
      } catch (error) {
        await recordFailure('state_invalid', correlationId);
        throw error;
      }
      if (!safeEqual(browserBinding, hmac(secret, 'platform-browser', state))) {
        await recordFailure('browser_binding_invalid', correlationId);
        throw new PlatformIdentityError('PLATFORM_OIDC_BROWSER_BINDING_INVALID');
      }
      const transaction = await repository.consume({ stateHash: sha256(state), securityEpoch });
      if (!transaction) {
        await recordFailure('state_invalid', correlationId);
        throw new PlatformIdentityError('PLATFORM_OIDC_STATE_INVALID');
      }
      const flowCorrelationId = transaction.correlationId;
      if (loginOnly && (transaction.purpose!=='login' || transaction.authenticationContext!==mfaAuthenticationContext)) {
        await recordFailure('state_invalid',flowCorrelationId);
        throw new PlatformIdentityError('PLATFORM_OIDC_LOGIN_TRANSACTION_REQUIRED');
      }
      if (primaryOnly && (transaction.purpose !== 'login'
        || transaction.authenticationContext !== 'cm:pk:primary:v1')) {
        await recordFailure('state_invalid', flowCorrelationId);
        throw new PlatformIdentityError('PLATFORM_PRIMARY_TRANSACTION_INVALID');
      }
      if (providerError !== null) {
        if (
          codeValue !== undefined
          || typeof providerError !== 'string'
          || !PROVIDER_ERROR_PATTERN.test(providerError)
        ) {
          await recordFailure('provider_error_invalid', flowCorrelationId);
          throw new PlatformIdentityError('PLATFORM_OIDC_PROVIDER_ERROR_INVALID');
        }
        await recordFailure('provider_rejected', flowCorrelationId);
        return Object.freeze({ status: 'authentication_rejected' });
      }
      const verifier = hmac(secret, 'platform-pkce', state);
      let assertion;
      try {
        assertion = await entraClient.redeemAuthorizationCode({
          code: code(codeValue),
          codeVerifier: verifier,
          expectedNonce: hmac(secret,'platform-oidc-nonce:v1',state),
          expectedNonceHash: transaction.nonceHash,
          ...(!primaryOnly ? { authenticationContext: transaction.authenticationContext } : {}),
        });
      } catch (error) {
        await recordFailure(redemptionFailureReason(error), flowCorrelationId);
        throw error;
      }
      if (primaryOnly) {
        try {
          const pending = await passkeyAuthService.startLogin(assertion, { correlationId: flowCorrelationId });
          if (!['passkey_required', 'enrollment_required'].includes(pending?.status) || pending.principal !== undefined
            || pending.csrfToken !== undefined || pending.setCookies !== undefined) {
            throw new PlatformIdentityError('PLATFORM_PRIMARY_PENDING_RESULT_INVALID');
          }
          return pending;
        } catch (error) {
          await recordFailure('assertion_rejected', flowCorrelationId);
          throw error;
        }
      }
      const identity = await identityService.verify(assertion, { correlationId: flowCorrelationId });
      if (loginOnly && (identity.assurance.level!=='mfa' || identity.assurance.authenticationContext!==mfaAuthenticationContext)) {
        await recordFailure('assertion_rejected',flowCorrelationId);
        throw new PlatformIdentityError('PLATFORM_OIDC_LOGIN_ASSURANCE_REQUIRED');
      }
      let issued;
      if (transaction.purpose === 'login') {
        issued = await sessionService.issue(identity, { correlationId: flowCorrelationId });
      } else {
        const current = await sessionService.resolvePrincipal(request);
        if (
          !current
          || current.operatorId !== transaction.expectedOperatorId
          || current.session.id !== transaction.expectedSessionId
          || current.securityVersion !== transaction.expectedSecurityVersion
          || current.session.securityEpoch !== transaction.securityEpoch
          || identity.operatorId !== current.operatorId
          || identity.assurance.level !== 'step_up'
        ) {
          if (current) {
            await recordStepUpDenied(current, 'step_up_binding_rejected', flowCorrelationId);
          } else {
            await recordFailure('step_up_binding_rejected', flowCorrelationId);
          }
          throw new PlatformIdentityError('PLATFORM_OIDC_STEP_UP_BINDING_INVALID');
        }
        issued = await sessionService.rotate(current, identity, {
          purpose: 'step_up',
          correlationId: flowCorrelationId,
        });
      }
      return Object.freeze({
        status: 'authenticated',
        principal: issued.principal,
        setCookie: issued.setCookie,
        csrfToken: issued.csrfToken,
      });
    },

    clearCookie() {
      return serializeClearedPlatformEntraTransactionCookie();
    },

    provider: PLATFORM_ENTRA_PROVIDER,
  });
}

export function createPlatformEntraAuthService(configuration) {
  return createAuthService(configuration);
}

// Exact-operation profiles cannot mint a reusable elevated browser session.
export function createPlatformEntraLoginAuthService(configuration) {
  return createAuthService(configuration,false,true);
}

// No primary-only session can be issued: completion delegates only to the
// independently verified passkey ceremony and never the legacy identity mapper.
export function createPlatformEntraPrimaryAuthService(configuration = {}) {
  return createAuthService({ transactionTtlSeconds: 300, ...configuration }, true);
}
