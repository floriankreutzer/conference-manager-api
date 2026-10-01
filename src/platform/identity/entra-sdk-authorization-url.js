import { PLATFORM_ENTRA_SCOPES } from './entra-authorization-url.js';

const MAX_AUTHORIZATION_URL_LENGTH = 8_192;
const MAX_CLIENT_METADATA_LENGTH = 2_048;
const OPTIONAL_SDK_CLAIMS = Object.freeze(['signin_state', 'login_hint', 'tenant_region_sub_scope']);

function invalid() {
  throw new TypeError('PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID');
}

function removeOptionalSdkClaims(parameters) {
  const value = parameters.get('claims');
  if (value === null) return;
  if (value.length > 4_096) invalid();
  let claims;
  try {
    claims = JSON.parse(value);
  } catch {
    invalid();
  }
  const idToken = claims?.id_token;
  if (!idToken || typeof idToken !== 'object' || Array.isArray(idToken)) invalid();
  for (const name of OPTIONAL_SDK_CLAIMS) {
    if (!Object.hasOwn(idToken, name)) continue;
    const request = idToken[name];
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).join(',') !== 'essential' || request.essential !== false) invalid();
    delete idToken[name];
  }
  // Preserve acrs and any unexpected property so the strict validator can reject
  // altered assurance or unknown claim requests instead of hiding them.
  parameters.set('claims', JSON.stringify(claims));
}

// This is an SDK-boundary adaptation, not a redirect validator. Every returned
// value must still pass validatePlatformEntraAuthorizationUrl with the original
// server-generated state, nonce, PKCE, callback and authentication context.
export function canonicalizePlatformEntraSdkUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_AUTHORIZATION_URL_LENGTH) invalid();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  const parameters = parsed.searchParams;
  if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1)) invalid();
  const scopes = (parameters.get('scope') || '').split(' ').filter(Boolean);
  const sdkScopes = [...PLATFORM_ENTRA_SCOPES, 'offline_access'];
  if (scopes.length === sdkScopes.length
    && new Set(scopes).size === scopes.length
    && sdkScopes.every((scope) => scopes.includes(scope))) {
    // Platform sign-in must not request an SDK-added offline/refresh grant.
    parameters.set('scope', PLATFORM_ENTRA_SCOPES.join(' '));
  }
  if (parameters.has('clidata')) {
    if (parameters.get('clidata').length > MAX_CLIENT_METADATA_LENGTH) invalid();
    // Discard optional SDK telemetry; it is not authentication authority and
    // must not expand the externally visible redirect contract.
    parameters.delete('clidata');
  }
  removeOptionalSdkClaims(parameters);
  return parsed.toString();
}
