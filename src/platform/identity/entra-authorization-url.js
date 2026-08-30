const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,64})?$/;
const QUERY_KEYS = new Set([
  'client_id',
  'scope',
  'redirect_uri',
  'client-request-id',
  'response_mode',
  'client_info',
  'nonce',
  'state',
  'claims',
  'max_age',
  'x-client-SKU',
  'x-client-VER',
  'x-client-OS',
  'x-client-CPU',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'return-client-request-id',
]);
const REQUIRED_QUERY_KEYS = Object.freeze([
  'client_id',
  'scope',
  'redirect_uri',
  'response_mode',
  'nonce',
  'state',
  'claims',
  'max_age',
  'code_challenge',
  'code_challenge_method',
  'response_type',
]);
const OPERATING_SYSTEMS = new Set(['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'aix']);
const PROCESSORS = new Set(['x64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x']);

export const PLATFORM_ENTRA_SCOPES = Object.freeze(['openid', 'profile']);

function invalid() {
  throw new TypeError('PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID');
}

function exactClaims(value, authenticationContext) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) return false;
  let claims;
  try {
    claims = JSON.parse(value);
  } catch {
    return false;
  }
  const idToken = claims?.id_token;
  const acrs = idToken?.acrs;
  return claims
    && typeof claims === 'object'
    && !Array.isArray(claims)
    && Object.keys(claims).join(',') === 'id_token'
    && idToken
    && typeof idToken === 'object'
    && !Array.isArray(idToken)
    && Object.keys(idToken).join(',') === 'acrs'
    && acrs
    && typeof acrs === 'object'
    && !Array.isArray(acrs)
    && Object.keys(acrs).sort().join(',') === 'essential,values'
    && acrs.essential === true
    && Array.isArray(acrs.values)
    && acrs.values.length === 1
    && acrs.values[0] === authenticationContext;
}

function exactScopes(value) {
  if (typeof value !== 'string') return false;
  const scopes = value.split(' ').filter(Boolean);
  return scopes.length === PLATFORM_ENTRA_SCOPES.length
    && new Set(scopes).size === scopes.length
    && PLATFORM_ENTRA_SCOPES.every((scope) => scopes.includes(scope));
}

function exactOrOpaque(actual, expected) {
  return OPAQUE_PATTERN.test(actual || '') && (expected === undefined || actual === expected);
}

export function validatePlatformEntraAuthorizationUrl(value, {
  authority,
  clientId,
  redirectUri,
  authenticationContext,
  authenticationMaxAgeSeconds,
  expectedState,
  expectedNonce,
  expectedCodeChallenge,
} = {}) {
  let parsed;
  let expectedAuthority;
  try {
    parsed = new URL(value);
    expectedAuthority = new URL(authority);
  } catch {
    invalid();
  }
  const authorityPath = expectedAuthority.pathname.replace(/\/$/, '');
  if (
    typeof value !== 'string'
    || value.length > 8_192
    || parsed.protocol !== 'https:'
    || parsed.origin !== expectedAuthority.origin
    || parsed.pathname !== `${authorityPath}/oauth2/v2.0/authorize`
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
    || typeof clientId !== 'string'
    || !GUID_PATTERN.test(clientId)
    || typeof redirectUri !== 'string'
    || typeof authenticationContext !== 'string'
    || !Number.isSafeInteger(authenticationMaxAgeSeconds)
    || authenticationMaxAgeSeconds < 0
    || authenticationMaxAgeSeconds > 1_800
  ) invalid();
  const keys = [...parsed.searchParams.keys()];
  if (
    keys.some((key) => !QUERY_KEYS.has(key) || parsed.searchParams.getAll(key).length !== 1)
    || REQUIRED_QUERY_KEYS.some((key) => !parsed.searchParams.has(key))
  ) invalid();
  const clientRequestId = parsed.searchParams.get('client-request-id');
  const returnClientRequestId = parsed.searchParams.get('return-client-request-id');
  const operatingSystem = parsed.searchParams.get('x-client-OS');
  const processor = parsed.searchParams.get('x-client-CPU');
  const version = parsed.searchParams.get('x-client-VER');
  if (
    parsed.searchParams.get('client_id') !== clientId.toLowerCase()
    || parsed.searchParams.get('redirect_uri') !== redirectUri
    || parsed.searchParams.get('response_mode') !== 'query'
    || parsed.searchParams.get('response_type') !== 'code'
    || parsed.searchParams.get('code_challenge_method') !== 'S256'
    || parsed.searchParams.get('max_age') !== String(authenticationMaxAgeSeconds)
    || !exactOrOpaque(parsed.searchParams.get('state'), expectedState)
    || !exactOrOpaque(parsed.searchParams.get('nonce'), expectedNonce)
    || !exactOrOpaque(parsed.searchParams.get('code_challenge'), expectedCodeChallenge)
    || !exactScopes(parsed.searchParams.get('scope'))
    || !exactClaims(parsed.searchParams.get('claims'), authenticationContext)
    || ![null, '1'].includes(parsed.searchParams.get('client_info'))
    || (clientRequestId !== null && !GUID_PATTERN.test(clientRequestId))
    || ![null, 'true'].includes(returnClientRequestId)
    || (returnClientRequestId !== null && clientRequestId === null)
    || ![null, 'msal.js.node'].includes(parsed.searchParams.get('x-client-SKU'))
    || (operatingSystem !== null && !OPERATING_SYSTEMS.has(operatingSystem))
    || (processor !== null && !PROCESSORS.has(processor))
    || (version !== null && !VERSION_PATTERN.test(version))
  ) invalid();
  return parsed.toString();
}
