import { PLATFORM_ENTRA_SCOPES } from './entra-authorization-url.js';

const MAX_AUTHORIZATION_URL_LENGTH = 8_192;
const MAX_CLIENT_METADATA_LENGTH = 2_048;

// This is an SDK-boundary adaptation, not a redirect validator. Every returned
// value must still pass validatePlatformEntraAuthorizationUrl with the original
// server-generated state, nonce, PKCE, callback and authentication context.
export function canonicalizePlatformEntraSdkUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_AUTHORIZATION_URL_LENGTH) {
    throw new TypeError('PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID');
  }
  const parameters = parsed.searchParams;
  if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1)) {
    throw new TypeError('PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID');
  }
  const scopes = (parameters.get('scope') || '').split(' ').filter(Boolean);
  const sdkScopes = [...PLATFORM_ENTRA_SCOPES, 'offline_access'];
  if (scopes.length === sdkScopes.length
    && new Set(scopes).size === scopes.length
    && sdkScopes.every((scope) => scopes.includes(scope))) {
    // Platform sign-in must not request an SDK-added offline/refresh grant.
    parameters.set('scope', PLATFORM_ENTRA_SCOPES.join(' '));
  }
  if (parameters.has('clidata')) {
    if (parameters.get('clidata').length > MAX_CLIENT_METADATA_LENGTH) {
      throw new TypeError('PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID');
    }
    // Discard optional SDK telemetry; it is not authentication authority and
    // must not expand the externally visible redirect contract.
    parameters.delete('clidata');
  }
  return parsed.toString();
}
