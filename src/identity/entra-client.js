import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { EntraAuthenticationError } from './entra-errors.js';

const ENTRA_PROVIDER = 'microsoft_entra';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OIDC_SCOPES = Object.freeze(['openid', 'profile']);
const MAX_DISPLAY_NAME_LENGTH = 200;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function secureHashMatch(value, expectedHash) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash || '')) return false;
  const actual = Buffer.from(sha256Hex(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireGuid(value, code) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) throw new EntraAuthenticationError(code);
  return value.toLowerCase();
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function validateAuthorizationUrl(value, authority) {
  let parsed;
  let expected;
  try {
    parsed = new URL(value);
    expected = new URL(authority);
  } catch {
    throw new EntraAuthenticationError('ENTRA_AUTHORIZATION_URL_INVALID');
  }
  const authorityPath = expected.pathname.replace(/\/$/, '');
  if (
    parsed.protocol !== 'https:'
    || parsed.origin !== expected.origin
    || parsed.pathname !== `${authorityPath}/oauth2/v2.0/authorize`
  ) {
    throw new EntraAuthenticationError('ENTRA_AUTHORIZATION_URL_INVALID');
  }
  return parsed.toString();
}

function validateIdTokenClaims(claims, {
  clientId,
  authority,
  expectedNonceHash,
  clock,
}) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new EntraAuthenticationError('ENTRA_ID_TOKEN_CLAIMS_INVALID');
  }

  const tenantReference = requireGuid(claims.tid, 'ENTRA_TENANT_CLAIM_INVALID');
  const userReference = requireGuid(claims.oid, 'ENTRA_USER_CLAIM_INVALID');
  if (claims.aud !== clientId) throw new EntraAuthenticationError('ENTRA_AUDIENCE_INVALID');

  const authorityUrl = new URL(authority);
  const expectedIssuer = `${authorityUrl.origin}/${tenantReference}/v2.0`;
  if (claims.iss !== expectedIssuer) throw new EntraAuthenticationError('ENTRA_ISSUER_INVALID');
  if (!secureHashMatch(claims.nonce, expectedNonceHash)) {
    throw new EntraAuthenticationError('ENTRA_NONCE_INVALID');
  }

  const nowSeconds = Math.floor(clock() / 1000);
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) {
    throw new EntraAuthenticationError('ENTRA_TOKEN_EXPIRED');
  }
  if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds + 300)) {
    throw new EntraAuthenticationError('ENTRA_TOKEN_NOT_YET_VALID');
  }
  if (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds + 300)) {
    throw new EntraAuthenticationError('ENTRA_TOKEN_ISSUED_AT_INVALID');
  }
  if (claims.ver !== undefined && claims.ver !== '2.0') {
    throw new EntraAuthenticationError('ENTRA_TOKEN_VERSION_INVALID');
  }

  return Object.freeze({
    provider: ENTRA_PROVIDER,
    tenantReference,
    userReference,
    displayName: normalizeDisplayName(claims.name),
  });
}

export function createEntraClient({
  clientId,
  clientSecret,
  authority,
  redirectUri,
  clock = () => Date.now(),
  application,
} = {}) {
  if (!GUID_PATTERN.test(clientId || '')) throw new TypeError('ENTRA_CLIENT_ID_INVALID');
  if (typeof clientSecret !== 'string' || clientSecret.length < 1) throw new TypeError('ENTRA_CLIENT_SECRET_REQUIRED');
  if (typeof authority !== 'string' || typeof redirectUri !== 'string') throw new TypeError('ENTRA_ENDPOINT_CONFIGURATION_REQUIRED');

  const msal = application || new ConfidentialClientApplication({
    auth: {
      clientId,
      authority,
      clientSecret,
    },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  });
  if (typeof msal.getAuthCodeUrl !== 'function' || typeof msal.acquireTokenByCode !== 'function') {
    throw new TypeError('ENTRA_APPLICATION_INVALID');
  }

  return Object.freeze({
    async authorizationUrl({ state, nonce, codeChallenge }) {
      try {
        const value = await msal.getAuthCodeUrl({
          scopes: OIDC_SCOPES,
          redirectUri,
          responseMode: 'query',
          state,
          nonce,
          codeChallenge,
          codeChallengeMethod: 'S256',
        });
        return validateAuthorizationUrl(value, authority);
      } catch (error) {
        if (error instanceof EntraAuthenticationError) throw error;
        throw new EntraAuthenticationError('ENTRA_AUTHORIZATION_START_FAILED');
      }
    },

    async redeemAuthorizationCode({ code, codeVerifier, expectedNonceHash }) {
      let result;
      try {
        result = await msal.acquireTokenByCode({
          code,
          scopes: OIDC_SCOPES,
          redirectUri,
          codeVerifier,
        });
      } catch {
        throw new EntraAuthenticationError('ENTRA_CODE_REDEMPTION_FAILED');
      }
      return validateIdTokenClaims(result?.idTokenClaims, {
        clientId,
        authority,
        expectedNonceHash,
        clock,
      });
    },
  });
}

export const ENTRA_IDENTITY_PROVIDER = ENTRA_PROVIDER;
