import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { PlatformIdentityError } from './errors.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { PLATFORM_MICROSOFT_OPERATION_CALLBACK } from './microsoft-operation-cookie.js';
import { canonicalizePlatformEntraSdkUrl } from './entra-sdk-authorization-url.js';
import {
  PLATFORM_ENTRA_SCOPES,
  validatePlatformEntraAuthorizationUrl,
  validatePlatformEntraPrimaryAuthorizationUrl,
  validatePlatformEntraMfaAuthorizationUrl,
} from './entra-authorization-url.js';

export { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
const OPERATION_PROVIDER_MAX_AGE_SECONDS=300;
const VERIFIED_ASSERTION = Symbol('verifiedPlatformEntraAssertion');
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code) {
  throw new PlatformIdentityError(code);
}

function hashMatches(value, expectedHash) {
  if (typeof value !== 'string' || typeof expectedHash!=='string' || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = createHash('sha256').update(value, 'utf8').digest();
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireGuid(value, code) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) fail(code);
  return value.toLowerCase();
}

function fixedAuthority(value, tenantReference) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('PLATFORM_ENTRA_AUTHORITY_INVALID');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'login.microsoftonline.com'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname.replace(/\/$/, '').toLowerCase() !== `/${tenantReference}`
  ) throw new TypeError('PLATFORM_ENTRA_AUTHORITY_INVALID');
  return parsed;
}

function fixedRedirect(value, publicOrigin, operationOnly) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('PLATFORM_ENTRA_REDIRECT_INVALID');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname !== (operationOnly ? PLATFORM_MICROSOFT_OPERATION_CALLBACK : '/api/v1/platform/auth/microsoft/callback')
    || parsed.origin !== publicOrigin
  ) throw new TypeError('PLATFORM_ENTRA_REDIRECT_INVALID');
  return parsed.toString();
}

function fixedPublicOrigin(value) {
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
  return parsed.origin;
}

function validateTokenIdentity(claims, {
  clientId,
  tenantReference,
  authority,
  expectedNonceHash,
  requestedAuthenticationMaxAgeSeconds,
  clock,
}) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) fail('PLATFORM_ENTRA_CLAIMS_INVALID');
  if (requireGuid(claims.tid, 'PLATFORM_ENTRA_TENANT_INVALID') !== tenantReference) {
    fail('PLATFORM_OPERATOR_TENANT_MISMATCH');
  }
  const subjectReference = requireGuid(claims.oid, 'PLATFORM_ENTRA_SUBJECT_INVALID');
  if (requireGuid(claims.aud, 'PLATFORM_AUDIENCE_MISMATCH') !== clientId) {
    fail('PLATFORM_AUDIENCE_MISMATCH');
  }
  const issuer = `${authority.origin}/${tenantReference}/v2.0`;
  if (claims.iss !== issuer) fail('PLATFORM_ISSUER_MISMATCH');
  if (!hashMatches(claims.nonce, expectedNonceHash)) fail('PLATFORM_ENTRA_NONCE_INVALID');
  const nowSeconds = Math.floor(clock() / 1000);
  if (claims.exp===undefined) fail('PLATFORM_ENTRA_TOKEN_EXPIRY_MISSING');
  if (!Number.isSafeInteger(claims.exp)) fail('PLATFORM_ENTRA_TOKEN_EXPIRY_INVALID');
  if (claims.exp <= nowSeconds) fail('PLATFORM_ENTRA_TOKEN_EXPIRED');
  if (!Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds + 60) {
    fail('PLATFORM_ENTRA_ISSUED_AT_INVALID');
  }
  if (!Number.isSafeInteger(claims.auth_time) || claims.auth_time > nowSeconds + 60) {
    fail('PLATFORM_ENTRA_AUTHENTICATION_TIME_INVALID');
  }
  if (claims.auth_time < nowSeconds - requestedAuthenticationMaxAgeSeconds - 60) {
    fail('PLATFORM_ENTRA_AUTHENTICATION_NOT_FRESH');
  }
  if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds + 60)) {
    fail('PLATFORM_ENTRA_NOT_YET_VALID');
  }
  if (claims.ver !== '2.0') fail('PLATFORM_ENTRA_TOKEN_VERSION_INVALID');
  return Object.freeze({
    provider: PLATFORM_ENTRA_PROVIDER, issuer, audience: clientId, tenantReference, subjectReference,
    authenticatedAt: new Date(claims.auth_time * 1000).toISOString(),
  });
}

function validateClaims(claims, contract) {
  const identity = validateTokenIdentity(claims, contract);
  if (!Array.isArray(claims.acrs) || claims.acrs.length !== 1
    || claims.acrs[0] !== contract.requestedAuthenticationContext) fail('PLATFORM_ASSURANCE_CONTEXT_REJECTED');
  return Object.freeze({ ...identity, authenticationContext: contract.requestedAuthenticationContext });
}

function createClient({
  clientId,
  clientSecret,
  tenantReference: tenantValue,
  authority: authorityValue,
  redirectUri: redirectValue,
  publicOrigin,
  mfaAuthenticationContext,
  stepUpAuthenticationContext,
  authenticationMaxAgeSeconds = 15 * 60,
  clock = () => Date.now(),
  application,
} = {}, primaryOnly = false, microsoftMfa = false, operationOnly = false) {
  const tenantReference = requireGuid(tenantValue, 'PLATFORM_ENTRA_TENANT_INVALID');
  if (!GUID_PATTERN.test(clientId || '')) throw new TypeError('PLATFORM_ENTRA_CLIENT_ID_INVALID');
  const normalizedClientId = clientId.toLowerCase();
  if (typeof clientSecret !== 'string' || clientSecret.length < 32
    || ((primaryOnly || microsoftMfa) && clientSecret.length > 512)) {
    throw new TypeError('PLATFORM_ENTRA_CLIENT_SECRET_INVALID');
  }
  const authority = fixedAuthority(authorityValue, tenantReference);
  const platformOrigin = fixedPublicOrigin(publicOrigin);
  const redirectUri = fixedRedirect(redirectValue, platformOrigin,operationOnly);
  if (!primaryOnly && (
    typeof mfaAuthenticationContext !== 'string'
    || typeof stepUpAuthenticationContext !== 'string'
    || mfaAuthenticationContext === stepUpAuthenticationContext
  )) throw new TypeError('PLATFORM_ENTRA_AUTHENTICATION_CONTEXT_INVALID');
  if (
    !Number.isSafeInteger(authenticationMaxAgeSeconds)
    || authenticationMaxAgeSeconds < 60
    || authenticationMaxAgeSeconds > (primaryOnly || microsoftMfa ? 300 : 1_800)
  ) throw new TypeError('PLATFORM_AUTHENTICATION_MAX_AGE_INVALID');
  if (primaryOnly && (mfaAuthenticationContext !== undefined || stepUpAuthenticationContext !== undefined)) {
    throw new TypeError('PLATFORM_PRIMARY_CONTEXT_CONFIGURATION_FORBIDDEN');
  }
  const primaryAssertions = new WeakMap();
  const contexts = new Set([mfaAuthenticationContext, stepUpAuthenticationContext]);
  const msal = application || new ConfidentialClientApplication({
    auth: { clientId: normalizedClientId, authority: authority.toString(), clientSecret },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
  });
  if (typeof msal.getAuthCodeUrl !== 'function' || typeof msal.acquireTokenByCode !== 'function') {
    throw new TypeError('PLATFORM_ENTRA_APPLICATION_INVALID');
  }

  function context(value) {
    if (!contexts.has(value) || operationOnly && value!==stepUpAuthenticationContext) {
      throw new TypeError('PLATFORM_ENTRA_AUTHENTICATION_CONTEXT_INVALID');
    }
    return value;
  }

  function maxAge(value) {
    return value === stepUpAuthenticationContext ? 0 : authenticationMaxAgeSeconds;
  }

  const primaryVerifier = {
    async verifyPrimary(assertion) {
      const verified = assertion && primaryAssertions.get(assertion);
      if (!verified) fail('PLATFORM_PRIMARY_ASSERTION_NOT_VERIFIED');
      primaryAssertions.delete(assertion);
      if (verified.expiresAt <= clock()
        || Date.parse(verified.identity.authenticatedAt) < clock() - (authenticationMaxAgeSeconds + 60) * 1000) {
        fail('PLATFORM_PRIMARY_ASSERTION_EXPIRED');
      }
      return verified.identity;
    },
  };
  const assuranceVerifier = {
    async verify(assertion) {
      if (!assertion || assertion[VERIFIED_ASSERTION] !== true) fail('PLATFORM_ASSERTION_NOT_VERIFIED');
      return Object.freeze({ verified: true, claims: assertion.claims });
    },
  };
  return Object.freeze({
    async authorizationUrl({ state, nonce, codeChallenge, authenticationContext }) {
      if (primaryOnly && authenticationContext !== undefined) fail('PLATFORM_PRIMARY_CONTEXT_FORBIDDEN');
      const requested = primaryOnly ? undefined : context(authenticationContext);
      const requestedMaxAge = operationOnly ? OPERATION_PROVIDER_MAX_AGE_SECONDS
        : primaryOnly ? authenticationMaxAgeSeconds : maxAge(requested);
      try {
        const claims = JSON.stringify({ id_token: microsoftMfa
          ? { auth_time: { essential: true }, amr: { essential: true, values: ['mfa'] } } : primaryOnly
          ? { auth_time: { essential: true } } : { acrs: { essential: true, values: [requested] } } });
        const value = await msal.getAuthCodeUrl({
          scopes: PLATFORM_ENTRA_SCOPES,
          redirectUri,
          responseMode: 'query',
          responseType: 'code',
          state,
          nonce,
          codeChallenge,
          codeChallengeMethod: 'S256',
          ...(operationOnly ? { prompt: 'login' } : {}),
          maxAge: requestedMaxAge,
          extraQueryParameters: { max_age: String(requestedMaxAge) },
          claims,
        });
        const validateUrl = microsoftMfa ? validatePlatformEntraMfaAuthorizationUrl
          : primaryOnly ? validatePlatformEntraPrimaryAuthorizationUrl : validatePlatformEntraAuthorizationUrl;
        return validateUrl(canonicalizePlatformEntraSdkUrl(value), {
          authority: authority.toString(),
          clientId: normalizedClientId,
          redirectUri,
          authenticationContext: microsoftMfa ? undefined : requested,
          authenticationMaxAgeSeconds: requestedMaxAge,
          expectedState: state,
          expectedNonce: nonce,
          expectedCodeChallenge: codeChallenge,
          expectedPrompt: operationOnly ? 'login' : undefined,
        });
      } catch (error) {
        if (error instanceof PlatformIdentityError) throw error;
        if (error?.message === 'PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID') {
          fail('PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID');
        }
        fail('PLATFORM_ENTRA_AUTHORIZATION_START_FAILED');
      }
    },

    async redeemAuthorizationCode({
      code,
      codeVerifier,
      expectedNonceHash,
      expectedNonce,
      authenticationContext,
    }) {
      if (primaryOnly && authenticationContext !== undefined) fail('PLATFORM_PRIMARY_CONTEXT_FORBIDDEN');
      const requested = primaryOnly ? undefined : context(authenticationContext);
      const requestedMaxAge = primaryOnly ? authenticationMaxAgeSeconds : maxAge(requested);
      if (typeof expectedNonce!=='string' || expectedNonce.length<1 || expectedNonce.length>512
        || !hashMatches(expectedNonce,expectedNonceHash)) {
        fail(primaryOnly ? 'PLATFORM_PRIMARY_CODE_INPUT_INVALID' : 'PLATFORM_ENTRA_NONCE_INVALID');
      }
      if ((primaryOnly || microsoftMfa) && (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(code)
        || typeof codeVerifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(codeVerifier)
        || !/^[0-9a-f]{64}$/.test(expectedNonceHash || ''))) {
        fail(primaryOnly ? 'PLATFORM_PRIMARY_CODE_INPUT_INVALID' : 'PLATFORM_MICROSOFT_MFA_CODE_INPUT_INVALID');
      }
      let result;
      try {
        result = await msal.acquireTokenByCode({
          code,
          scopes: PLATFORM_ENTRA_SCOPES,
          redirectUri,
          codeVerifier,
          nonce: expectedNonce,
        });
      } catch {
        fail('PLATFORM_ENTRA_CODE_REDEMPTION_FAILED');
      }
      const validate = primaryOnly || microsoftMfa ? validateTokenIdentity : validateClaims;
      const claims = validate(result?.idTokenClaims, {
        clientId: normalizedClientId,
        tenantReference,
        authority,
        expectedNonceHash,
        requestedAuthenticationContext: requested,
        requestedAuthenticationMaxAgeSeconds: requestedMaxAge,
        clock,
      });
      if (primaryOnly || microsoftMfa) {
        if (result.idTokenClaims.exp > Math.floor(clock() / 1000) + 86400) fail('PLATFORM_ENTRA_TOKEN_LIFETIME_INVALID');
        if (result.idTokenClaims.iat < 0) fail('PLATFORM_ENTRA_ISSUED_AT_NEGATIVE');
        if (result.idTokenClaims.auth_time < 0) fail('PLATFORM_ENTRA_AUTHENTICATION_TIME_NEGATIVE');
        if (result.idTokenClaims.exp <= result.idTokenClaims.iat) fail('PLATFORM_ENTRA_TOKEN_EXPIRY_ORDER_INVALID');
        // OIDC validates issuance age and authentication freshness against the RP clock independently.
        const issuanceMaxAge=operationOnly ? OPERATION_PROVIDER_MAX_AGE_SECONDS : requestedMaxAge;
        if (result.idTokenClaims.iat < Math.floor(clock() / 1000) - issuanceMaxAge - 60) {
          fail('PLATFORM_ENTRA_ISSUED_AT_NOT_FRESH');
        }
        if (result.idTokenClaims.auth_time >= result.idTokenClaims.exp) {
          fail('PLATFORM_ENTRA_AUTHENTICATION_EXPIRY_ORDER_INVALID');
        }
        if (microsoftMfa) {
          const methods = result.idTokenClaims.amr;
          if (!Array.isArray(methods) || methods.length < 1 || methods.length > 16
            || methods.some(method => typeof method !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(method))
            || new Set(methods).size !== methods.length || !methods.includes('mfa')) {
            fail('PLATFORM_MICROSOFT_MFA_REQUIRED');
          }
          const assertion = Object.freeze({ status: 'microsoft_mfa_verified' });
          primaryAssertions.set(assertion, { identity: Object.freeze({ ...claims, authenticationContext: requested }),
            expiresAt: result.idTokenClaims.exp * 1000, maxAgeSeconds: requestedMaxAge });
          return assertion;
        }
        const assertion = Object.freeze({ status: 'primary_verified' });
        primaryAssertions.set(assertion, { identity: claims, expiresAt: result.idTokenClaims.exp * 1000 });
        return assertion;
      }
      return Object.freeze({ [VERIFIED_ASSERTION]: true, claims });
    },

    ...(microsoftMfa ? { async verify(assertion) {
      const verified = assertion && primaryAssertions.get(assertion);
      if (!verified) fail('PLATFORM_ASSERTION_NOT_VERIFIED');
      primaryAssertions.delete(assertion);
      if (verified.expiresAt <= clock()
        || Date.parse(verified.identity.authenticatedAt) < clock() - (verified.maxAgeSeconds + 60) * 1000) {
        fail('PLATFORM_MICROSOFT_MFA_EXPIRED');
      }
      return Object.freeze({ verified: true, claims: verified.identity });
    } } : primaryOnly ? primaryVerifier : assuranceVerifier),
  });
}

export function createPlatformEntraClient(configuration) {
  return createClient(configuration);
}

// Deliberately exposes verifyPrimary rather than the assurance verifier contract.
// The result cannot satisfy the existing Platform identity/session model.
export function createPlatformEntraPrimaryClient(configuration = {}) {
  return createClient({ authenticationMaxAgeSeconds: 300, ...configuration }, true);
}

// Microsoft-issued MFA evidence is mandatory. Primary identity and a requested
// claim alone never establish assurance. Assertions are instance-bound/one-use.
export function createPlatformEntraMfaClient(configuration = {}) {
  return createClient({ authenticationMaxAgeSeconds: 300, ...configuration }, false, true);
}

// Dedicated fixed callback and fresh context only. No login session or ordinary
// authentication context can substitute for the operation's provider ceremony.
export function createPlatformEntraOperationClient(configuration = {}) {
  return createClient({ authenticationMaxAgeSeconds: 300,...configuration },false,true,true);
}
