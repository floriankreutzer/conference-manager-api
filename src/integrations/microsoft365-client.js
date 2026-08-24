import { ConfidentialClientApplication } from '@azure/msal-node';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_SCOPE = `${GRAPH_ORIGIN}/.default`;
const CONSENT_PATH_SUFFIX = '/v2.0/adminconsent';
const DEFAULT_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_MAX = 32_768;

export const MICROSOFT365_PROVIDER = 'microsoft365';
export const MICROSOFT365_BASE_PERMISSIONS = Object.freeze([
  'Place.Read.All',
  'Calendars.ReadBasic',
]);

export const MICROSOFT365_VERIFICATION = Object.freeze({
  CONNECTED: 'connected',
  DEGRADED: 'degraded',
  REVOKED: 'revoked',
});

export class Microsoft365ProviderError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = 'Microsoft365ProviderError';
    this.code = code;
  }
}

function requireGuid(value, code) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) throw new Microsoft365ProviderError(code);
  return value.toLowerCase();
}

function requireState(value) {
  if (typeof value !== 'string' || !STATE_PATTERN.test(value)) {
    throw new Microsoft365ProviderError('MICROSOFT365_CONSENT_STATE_INVALID');
  }
  return value;
}

function validAccessToken(value) {
  return typeof value === 'string'
    && value.length >= 32
    && value.length <= ACCESS_TOKEN_MAX
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function createMsalApplication({ clientId, clientSecret, tenantReference, applicationFactory }) {
  const authority = `${LOGIN_ORIGIN}/${tenantReference}`;
  if (applicationFactory) {
    const application = applicationFactory({ clientId, clientSecret, authority });
    if (!application || typeof application.acquireTokenByClientCredential !== 'function') {
      throw new TypeError('MICROSOFT365_MSAL_APPLICATION_INVALID');
    }
    return application;
  }
  return new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  });
}

function classifyGraphStatus(status) {
  if (status === 401) return 'revoked';
  if (status === 403) return 'permission_missing';
  if (status === 429 || status >= 500) return 'transient';
  if (status === 404) return 'not_found';
  return status >= 200 && status < 300 ? 'ok' : 'invalid';
}

async function readBoundedJson(response, maxBytes = 65_536) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_TOO_LARGE');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_TOO_LARGE');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
}

function validCollectionPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Array.isArray(payload.value)
    && payload.value.length <= 100;
}

function validCalendarPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof payload.id === 'string'
    && payload.id.length >= 1
    && payload.id.length <= 512;
}

async function fetchGraph(fetchImpl, url, accessToken, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
  }
  return response;
}

export function createMicrosoft365Client({
  clientId,
  clientSecret,
  publicOrigin,
  fetchImpl = globalThis.fetch,
  applicationFactory,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedClientId = requireGuid(clientId, 'MICROSOFT365_CLIENT_ID_INVALID');
  if (typeof clientSecret !== 'string' || clientSecret.length < 1) {
    throw new TypeError('MICROSOFT365_CLIENT_SECRET_REQUIRED');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('MICROSOFT365_FETCH_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new TypeError('MICROSOFT365_TIMEOUT_INVALID');
  }

  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new TypeError('MICROSOFT365_PUBLIC_ORIGIN_INVALID');
  }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('MICROSOFT365_PUBLIC_ORIGIN_INVALID');
  }
  const redirectUri = new URL('/api/v1/integrations/microsoft365/callback', origin).toString();

  async function acquireAccessToken(tenantReference) {
    const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
    const application = createMsalApplication({
      clientId: normalizedClientId,
      clientSecret,
      tenantReference: tenant,
      applicationFactory,
    });
    let result;
    try {
      result = await application.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
    } catch {
      throw new Microsoft365ProviderError('MICROSOFT365_TOKEN_ACQUISITION_FAILED');
    }
    if (!validAccessToken(result?.accessToken)) {
      throw new Microsoft365ProviderError('MICROSOFT365_TOKEN_INVALID');
    }
    return result.accessToken;
  }

  return Object.freeze({
    redirectUri,

    adminConsentUrl({ tenantReference, state }) {
      const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
      const url = new URL(`${LOGIN_ORIGIN}/${tenant}${CONSENT_PATH_SUFFIX}`);
      url.searchParams.set('client_id', normalizedClientId);
      url.searchParams.set('scope', GRAPH_SCOPE);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', requireState(state));
      return url.toString();
    },

    async verifyBasePermissions({ tenantReference, claimantUserReference = null }) {
      const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
      let accessToken;
      try {
        accessToken = await acquireAccessToken(tenant);
      } catch (error) {
        if (error instanceof Microsoft365ProviderError) {
          return Object.freeze({
            status: MICROSOFT365_VERIFICATION.REVOKED,
            places: 'unknown',
            calendars: 'unknown',
            reason: 'token_unavailable',
          });
        }
        throw error;
      }

      const placesUrl = new URL('/v1.0/places/microsoft.graph.room', GRAPH_ORIGIN);
      placesUrl.searchParams.set('$top', '1');
      placesUrl.searchParams.set('$select', 'id');
      const placesResponse = await fetchGraph(fetchImpl, placesUrl, accessToken, timeoutMs);
      const placesClass = classifyGraphStatus(placesResponse.status);
      if (placesClass === 'revoked') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.REVOKED, places: 'unknown', calendars: 'unknown', reason: 'provider_unauthorized' });
      }
      if (placesClass === 'transient') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'unknown', calendars: 'unknown', reason: 'provider_unavailable' });
      }
      if (placesClass === 'permission_missing') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'missing', calendars: 'unknown', reason: 'places_permission_missing' });
      }
      if (placesClass !== 'ok') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'unknown', calendars: 'unknown', reason: 'provider_response_invalid' });
      }
      const placesPayload = await readBoundedJson(placesResponse);
      if (!validCollectionPayload(placesPayload)) {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'unknown', calendars: 'unknown', reason: 'provider_response_invalid' });
      }

      if (claimantUserReference === null) {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.CONNECTED, places: 'granted', calendars: 'unverified', reason: null });
      }

      const claimant = requireGuid(claimantUserReference, 'MICROSOFT365_USER_INVALID');
      const calendarUrl = new URL(`/v1.0/users/${claimant}/calendar`, GRAPH_ORIGIN);
      calendarUrl.searchParams.set('$select', 'id');
      const calendarResponse = await fetchGraph(fetchImpl, calendarUrl, accessToken, timeoutMs);
      const calendarClass = classifyGraphStatus(calendarResponse.status);
      if (calendarClass === 'revoked') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.REVOKED, places: 'granted', calendars: 'unknown', reason: 'provider_unauthorized' });
      }
      if (calendarClass === 'permission_missing') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'granted', calendars: 'missing', reason: 'calendars_permission_missing' });
      }
      if (calendarClass === 'transient') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'granted', calendars: 'unknown', reason: 'provider_unavailable' });
      }
      if (calendarClass === 'not_found') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.CONNECTED, places: 'granted', calendars: 'unverified', reason: null });
      }
      if (calendarClass !== 'ok') {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'granted', calendars: 'unknown', reason: 'provider_response_invalid' });
      }
      const calendarPayload = await readBoundedJson(calendarResponse);
      if (!validCalendarPayload(calendarPayload)) {
        return Object.freeze({ status: MICROSOFT365_VERIFICATION.DEGRADED, places: 'granted', calendars: 'unknown', reason: 'provider_response_invalid' });
      }
      return Object.freeze({ status: MICROSOFT365_VERIFICATION.CONNECTED, places: 'granted', calendars: 'granted', reason: null });
    },
  });
}
