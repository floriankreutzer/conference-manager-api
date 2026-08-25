import { ConfidentialClientApplication } from '@azure/msal-node';
import { APPROVED_OUTBOUND_ORIGINS } from '../config.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_ORIGIN = APPROVED_OUTBOUND_ORIGINS.microsoftIdentity;
const GRAPH_ORIGIN = APPROVED_OUTBOUND_ORIGINS.microsoftGraph;
const GRAPH_SCOPE = `${GRAPH_ORIGIN}/.default`;
const CONSENT_PATH_SUFFIX = '/v2.0/adminconsent';
const DEFAULT_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_MAX = 32_768;
const PROVIDER_REQUEST_MAX_BYTES = 65_536;
const PROVIDER_RESPONSE_MAX_BYTES = 65_536;
const PROVIDER_URL_MAX_LENGTH = 4_096;
const PROVIDER_HEADER_COUNT_MAX = 64;
const PROVIDER_HEADER_NAME_MAX = 128;
const PROVIDER_HEADER_VALUE_MAX = 16_384;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const MICROSOFT365_PROVIDER = 'microsoft365';
export const MICROSOFT365_BASE_PERMISSIONS = Object.freeze([
  'Place.Read.All',
  'Calendars.ReadBasic.All',
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
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
    throw new Microsoft365ProviderError(code);
  }
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

function requireMicrosoftIdentityUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_URL_INVALID');
  }
  if (
    url.origin !== LOGIN_ORIGIN
    || url.username
    || url.password
    || url.hash
    || url.href.length > PROVIDER_URL_MAX_LENGTH
  ) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_URL_INVALID');
  }
  return url;
}

function boundedRequestHeaders(options) {
  if (options?.headers === undefined) return undefined;
  if (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers)) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
  }
  const entries = Object.entries(options.headers);
  if (entries.length > PROVIDER_HEADER_COUNT_MAX) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
  }
  const headers = {};
  for (const [name, value] of entries) {
    if (
      name.length < 1
      || name.length > PROVIDER_HEADER_NAME_MAX
      || typeof value !== 'string'
      || value.length > PROVIDER_HEADER_VALUE_MAX
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(value)
    ) {
      throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
    }
    headers[name] = value;
  }
  return headers;
}

function boundedRequestBody(options) {
  const body = options?.body ?? '';
  if (typeof body !== 'string' || Buffer.byteLength(body) > PROVIDER_REQUEST_MAX_BYTES) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
  }
  return body;
}

function boundedIdentityTimeout(requestedTimeoutMs, configuredTimeoutMs) {
  if (requestedTimeoutMs === undefined) return configuredTimeoutMs;
  if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_TIMEOUT_INVALID');
  }
  return Math.min(requestedTimeoutMs, configuredTimeoutMs);
}

function createMsalApplication({
  clientId,
  clientSecret,
  tenantReference,
  fetchImpl,
  timeoutMs,
  applicationFactory,
}) {
  const authority = `${LOGIN_ORIGIN}/${tenantReference}`;
  const networkClient = createBoundedMicrosoftIdentityNetworkClient({ fetchImpl, timeoutMs });
  if (applicationFactory) {
    const application = applicationFactory({ clientId, clientSecret, authority, networkClient });
    if (!application || typeof application.acquireTokenByClientCredential !== 'function') {
      throw new TypeError('MICROSOFT365_MSAL_APPLICATION_INVALID');
    }
    return application;
  }
  return new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority },
    system: {
      networkClient,
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

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort after the response has already failed validation.
  }
}

async function readBoundedText(response, maxBytes) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_TOO_LARGE');
  }

  const reader = response.body?.getReader?.();
  if (!reader || typeof reader.read !== 'function') {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }

  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
      }
      if (!result || typeof result.done !== 'boolean') {
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
      }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        await cancelReader(reader);
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function readBoundedJson(response, maxBytes = PROVIDER_RESPONSE_MAX_BYTES) {
  let text;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch (error) {
    if (error instanceof Microsoft365ProviderError) throw error;
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
}

function boundedResponseHeaders(response) {
  if (!response.headers || typeof response.headers.forEach !== 'function') {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  const headers = {};
  let count = 0;
  response.headers.forEach((value, name) => {
    count += 1;
    if (
      count > PROVIDER_HEADER_COUNT_MAX
      || name.length < 1
      || name.length > PROVIDER_HEADER_NAME_MAX
      || value.length > PROVIDER_HEADER_VALUE_MAX
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(value)
    ) {
      throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
    }
    headers[name] = value;
  });
  return headers;
}

async function fetchMicrosoftIdentity({
  fetchImpl,
  value,
  method,
  options,
  timeoutMs,
}) {
  const url = requireMicrosoftIdentityUrl(value);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: boundedRequestHeaders(options),
      body: method === 'POST' ? boundedRequestBody(options) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Microsoft365ProviderError) throw error;
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_UNAVAILABLE');
  }
  if (!response || !Number.isInteger(response.status)) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  return {
    headers: boundedResponseHeaders(response),
    body: await readBoundedJson(response),
    status: response.status,
  };
}

function createBoundedMicrosoftIdentityNetworkClient({ fetchImpl, timeoutMs }) {
  return Object.freeze({
    sendGetRequestAsync(value, options, requestedTimeoutMs) {
      return fetchMicrosoftIdentity({
        fetchImpl,
        value,
        method: 'GET',
        options,
        timeoutMs: boundedIdentityTimeout(requestedTimeoutMs, timeoutMs),
      });
    },
    sendPostRequestAsync(value, options) {
      return fetchMicrosoftIdentity({
        fetchImpl,
        value,
        method: 'POST',
        options,
        timeoutMs,
      });
    },
  });
}

async function validGraphPayload(response, validate) {
  try {
    return validate(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof Microsoft365ProviderError) return false;
    throw error;
  }
}

function validCollectionPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Array.isArray(payload.value)
    && payload.value.length <= 100
    && payload.value.every((item) => item
      && typeof item === 'object'
      && !Array.isArray(item)
      && typeof item.id === 'string'
      && item.id.length >= 1
      && item.id.length <= 512);
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
  if (url.origin !== GRAPH_ORIGIN) {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_ORIGIN_INVALID');
  }
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
  if (!response || !Number.isInteger(response.status)) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  return response;
}

function revoked(reason = 'provider_unauthorized', places = 'unknown') {
  return Object.freeze({
    status: MICROSOFT365_VERIFICATION.REVOKED,
    places,
    calendars: 'unknown',
    reason,
  });
}

function degraded({ places = 'unknown', calendars = 'unknown', reason }) {
  return Object.freeze({
    status: MICROSOFT365_VERIFICATION.DEGRADED,
    places,
    calendars,
    reason,
  });
}

function isValidCallbackOrigin(origin, allowInsecureLocalhost) {
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    return false;
  }
  if (origin.protocol === 'https:') return true;
  return allowInsecureLocalhost === true
    && origin.protocol === 'http:'
    && LOCAL_HOSTS.has(origin.hostname);
}

export function createMicrosoft365Client({
  clientId,
  clientSecret,
  publicOrigin,
  fetchImpl = globalThis.fetch,
  applicationFactory,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowInsecureLocalhost = false,
} = {}) {
  const normalizedClientId = requireGuid(clientId, 'MICROSOFT365_CLIENT_ID_INVALID');
  if (typeof clientSecret !== 'string' || clientSecret.length < 1) {
    throw new TypeError('MICROSOFT365_CLIENT_SECRET_REQUIRED');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('MICROSOFT365_FETCH_REQUIRED');
  if (typeof allowInsecureLocalhost !== 'boolean') {
    throw new TypeError('MICROSOFT365_LOCALHOST_MODE_INVALID');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new TypeError('MICROSOFT365_TIMEOUT_INVALID');
  }

  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new TypeError('MICROSOFT365_PUBLIC_ORIGIN_INVALID');
  }
  if (!isValidCallbackOrigin(origin, allowInsecureLocalhost)) {
    throw new TypeError('MICROSOFT365_PUBLIC_ORIGIN_INVALID');
  }
  const redirectUri = new URL('/api/v1/integrations/microsoft365/callback', origin).toString();

  async function acquireAccessToken(tenantReference) {
    const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
    const application = createMsalApplication({
      clientId: normalizedClientId,
      clientSecret,
      tenantReference: tenant,
      fetchImpl,
      timeoutMs,
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
        if (error instanceof Microsoft365ProviderError && error.code === 'MICROSOFT365_TOKEN_INVALID') {
          return revoked('token_invalid');
        }
        if (error instanceof Microsoft365ProviderError) {
          return degraded({ reason: 'provider_unavailable' });
        }
        throw error;
      }

      const placesUrl = new URL('/v1.0/places/microsoft.graph.room', GRAPH_ORIGIN);
      placesUrl.searchParams.set('$top', '1');
      placesUrl.searchParams.set('$select', 'id');
      let placesResponse;
      try {
        placesResponse = await fetchGraph(fetchImpl, placesUrl, accessToken, timeoutMs);
      } catch (error) {
        if (error instanceof Microsoft365ProviderError) {
          return degraded({ reason: 'provider_unavailable' });
        }
        throw error;
      }
      const placesClass = classifyGraphStatus(placesResponse.status);
      if (placesClass === 'revoked') return revoked();
      if (placesClass === 'transient') return degraded({ reason: 'provider_unavailable' });
      if (placesClass === 'permission_missing') {
        return degraded({ places: 'missing', reason: 'places_permission_missing' });
      }
      if (placesClass !== 'ok' || !await validGraphPayload(placesResponse, validCollectionPayload)) {
        return degraded({ reason: 'provider_response_invalid' });
      }

      if (claimantUserReference === null) {
        return degraded({
          places: 'granted',
          calendars: 'unverified',
          reason: 'calendars_permission_unverified',
        });
      }

      const claimant = requireGuid(claimantUserReference, 'MICROSOFT365_USER_INVALID');
      const calendarUrl = new URL(`/v1.0/users/${claimant}/calendar`, GRAPH_ORIGIN);
      calendarUrl.searchParams.set('$select', 'id');
      let calendarResponse;
      try {
        calendarResponse = await fetchGraph(fetchImpl, calendarUrl, accessToken, timeoutMs);
      } catch (error) {
        if (error instanceof Microsoft365ProviderError) {
          return degraded({ places: 'granted', reason: 'provider_unavailable' });
        }
        throw error;
      }
      const calendarClass = classifyGraphStatus(calendarResponse.status);
      if (calendarClass === 'revoked') return revoked('provider_unauthorized', 'granted');
      if (calendarClass === 'permission_missing') {
        return degraded({
          places: 'granted',
          calendars: 'missing',
          reason: 'calendars_permission_missing',
        });
      }
      if (calendarClass === 'transient') {
        return degraded({ places: 'granted', reason: 'provider_unavailable' });
      }
      if (calendarClass === 'not_found') {
        return degraded({
          places: 'granted',
          calendars: 'unverified',
          reason: 'calendars_permission_unverified',
        });
      }
      if (calendarClass !== 'ok' || !await validGraphPayload(calendarResponse, validCalendarPayload)) {
        return degraded({ places: 'granted', reason: 'provider_response_invalid' });
      }
      return Object.freeze({
        status: MICROSOFT365_VERIFICATION.CONNECTED,
        places: 'granted',
        calendars: 'granted',
        reason: null,
      });
    },
  });
}
