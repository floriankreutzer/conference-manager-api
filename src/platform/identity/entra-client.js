import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { PlatformIdentityError } from './errors.js';
import { canonicalizePlatformEntraSdkUrl } from './entra-sdk-authorization-url.js';
import {
  PLATFORM_ENTRA_SCOPES,
  validatePlatformEntraAuthorizationUrl,
} from './entra-authorization-url.js';

export const PLATFORM_ENTRA_PROVIDER = 'microsoft_entra_platform';
const VERIFIED_ASSERTION = Symbol('verifiedPlatformEntraAssertion');
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code) {
  throw new PlatformIdentityError(code);
}

function hashMatches(value, expectedHash) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash || '')) return false;
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

function fixedRedirect(value, publicOrigin) {
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
    || parsed.pathname !== '/api/v1/platform/auth/microsoft/callback'
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

function validateClaims(claims, {
  clientId,
  tenantReference,
  authority,
  expectedNonceHash,
  requestedAuthenticationContext,
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
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) fail('PLATFORM_ENTRA_TOKEN_EXPIRED');
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
  if (
    !Array.isArray(claims.acrs)
    || claims.acrs.length !== 1
    || claims.acrs[0] !== requestedAuthenticationContext
  ) fail('PLATFORM_ASSURANCE_CONTEXT_REJECTED');
  return Object.freeze({
    provider: PLATFORM_ENTRA_PROVIDER,
    issuer,
    audience: clientId,
    tenantReference,
    subjectReference,
    authenticationContext: requestedAuthenticationContext,
    authenticatedAt: new Date(claims.auth_time * 1000).toISOString(),
  });
}

export function createPlatformEntraClient({
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
} = {}) {
  const tenantReference = requireGuid(tenantValue, 'PLATFORM_ENTRA_TENANT_INVALID');
  if (!GUID_PATTERN.test(clientId || '')) throw new TypeError('PLATFORM_ENTRA_CLIENT_ID_INVALID');
  const normalizedClientId = clientId.toLowerCase();
  if (typeof clientSecret !== 'string' || clientSecret.length < 32) {
    throw new TypeError('PLATFORM_ENTRA_CLIENT_SECRET_INVALID');
  }
  const authority = fixedAuthority(authorityValue, tenantReference);
  const platformOrigin = fixedPublicOrigin(publicOrigin);
  const redirectUri = fixedRedirect(redirectValue, platformOrigin);
  if (
    typeof mfaAuthenticationContext !== 'string'
    || typeof stepUpAuthenticationContext !== 'string'
    || mfaAuthenticationContext === stepUpAuthenticationContext
  ) throw new TypeError('PLATFORM_ENTRA_AUTHENTICATION_CONTEXT_INVALID');
  if (
    !Number.isSafeInteger(authenticationMaxAgeSeconds)
    || authenticationMaxAgeSeconds < 60
    || authenticationMaxAgeSeconds > 1_800
  ) throw new TypeError('PLATFORM_AUTHENTICATION_MAX_AGE_INVALID');
  const contexts = new Set([mfaAuthenticationContext, stepUpAuthenticationContext]);
  const msal = application || new ConfidentialClientApplication({
    auth: { clientId: normalizedClientId, authority: authority.toString(), clientSecret },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
  });
  if (typeof msal.getAuthCodeUrl !== 'function' || typeof msal.acquireTokenByCode !== 'function') {
    throw new TypeError('PLATFORM_ENTRA_APPLICATION_INVALID');
  }

  function context(value) {
    if (!contexts.has(value)) throw new TypeError('PLATFORM_ENTRA_AUTHENTICATION_CONTEXT_INVALID');
    return value;
  }

  function maxAge(value) {
    return value === stepUpAuthenticationContext ? 0 : authenticationMaxAgeSeconds;
  }

  return Object.freeze({
    async authorizationUrl({ state, nonce, codeChallenge, authenticationContext }) {
      const requested = context(authenticationContext);
      const requestedMaxAge = maxAge(requested);
      try {
        const claims = JSON.stringify({ id_token: { acrs: { essential: true, values: [requested] } } });
        const value = await msal.getAuthCodeUrl({
          scopes: PLATFORM_ENTRA_SCOPES,
          redirectUri,
          responseMode: 'query',
          responseType: 'code',
          state,
          nonce,
          codeChallenge,
          codeChallengeMethod: 'S256',
          maxAge: requestedMaxAge,
          extraQueryParameters: { max_age: String(requestedMaxAge) },
          claims,
        });
        return validatePlatformEntraAuthorizationUrl(canonicalizePlatformEntraSdkUrl(value), {
          authority: authority.toString(),
          clientId: normalizedClientId,
          redirectUri,
          authenticationContext: requested,
          authenticationMaxAgeSeconds: requestedMaxAge,
          expectedState: state,
          expectedNonce: nonce,
          expectedCodeChallenge: codeChallenge,
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
      authenticationContext,
    }) {
      const requested = context(authenticationContext);
      const requestedMaxAge = maxAge(requested);
      let result;
      try {
        result = await msal.acquireTokenByCode({
          code,
          scopes: PLATFORM_ENTRA_SCOPES,
          redirectUri,
          codeVerifier,
        });
      } catch {
        fail('PLATFORM_ENTRA_CODE_REDEMPTION_FAILED');
      }
      const claims = validateClaims(result?.idTokenClaims, {
        clientId: normalizedClientId,
        tenantReference,
        authority,
        expectedNonceHash,
        requestedAuthenticationContext: requested,
        requestedAuthenticationMaxAgeSeconds: requestedMaxAge,
        clock,
      });
      return Object.freeze({ [VERIFIED_ASSERTION]: true, claims });
    },

    async verify(assertion) {
      if (!assertion || assertion[VERIFIED_ASSERTION] !== true) {
        fail('PLATFORM_ASSERTION_NOT_VERIFIED');
      }
      return Object.freeze({ verified: true, claims: assertion.claims });
    },
  });
}
