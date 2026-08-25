import { ApiError } from '../api-error.js';
import {
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
} from '../application/microsoft365-connection-errors.js';

export const MICROSOFT365_ROUTES = Object.freeze({
  connection: '/api/v1/integrations/microsoft365',
  connect: '/api/v1/integrations/microsoft365/connect',
  callback: '/api/v1/integrations/microsoft365/callback',
  verify: '/api/v1/integrations/microsoft365/verify',
  rooms: '/api/v1/integrations/microsoft365/rooms',
});

const CALLBACK_QUERY_KEYS = new Set([
  'admin_consent',
  'tenant',
  'state',
  'scope',
  'error',
  'error_description',
  'error_codes',
  'timestamp',
  'trace_id',
  'correlation_id',
  'error_uri',
]);
const CALLBACK_VALUE_LIMITS = Object.freeze({
  admin_consent: 8,
  tenant: 36,
  state: 43,
  scope: 2_048,
  error: 128,
  error_description: 1_024,
  error_codes: 512,
  timestamp: 64,
  trace_id: 64,
  correlation_id: 64,
  error_uri: 2_048,
});
const ERROR_DETAIL_KEYS = Object.freeze(['error_description', 'error_codes', 'error_uri']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_ERROR_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CALLBACK_FAILURES = [
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
];
const CALLBACK_REDIRECTS = Object.freeze({
  connected: '/?integration=microsoft365_connected',
  degraded: '/?integration=microsoft365_degraded',
  revoked: '/?integration=microsoft365_revoked',
  disconnected: '/?integration=microsoft365_consent_denied',
});

function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function sendRedirect(response, location) {
  response.statusCode = 303;
  response.setHeader('Location', location);
  response.setHeader('Content-Length', '0');
  response.removeHeader('Content-Type');
  response.end();
}

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
}

async function assertEmptyBody(request) {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    if (Array.isArray(contentLength) || !/^\d+$/.test(contentLength) || Number(contentLength) !== 0) {
      throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
    }
  }
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
}

function assertCallbackQueryValues(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    const values = parsedUrl.searchParams.getAll(key);
    const value = values[0];
    if (
      !CALLBACK_QUERY_KEYS.has(key)
      || values.length !== 1
      || typeof value !== 'string'
      || value.length > CALLBACK_VALUE_LIMITS[key]
      || CONTROL_CHARACTER.test(value)
    ) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
}

function callbackFromUrl(parsedUrl) {
  assertCallbackQueryValues(parsedUrl);

  const state = parsedUrl.searchParams.get('state');
  const tenant = parsedUrl.searchParams.get('tenant');
  const adminConsent = parsedUrl.searchParams.get('admin_consent');
  const providerError = parsedUrl.searchParams.get('error');
  if (typeof state !== 'string' || !STATE_PATTERN.test(state)) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  if (tenant !== null && !GUID_PATTERN.test(tenant)) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  if (providerError !== null && !PROVIDER_ERROR_PATTERN.test(providerError)) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }

  if (providerError !== null) {
    if (adminConsent !== null) throw new ApiError(400, 'VALIDATION_FAILED');
    return Object.freeze({
      state,
      providerTenantReference: tenant?.toLowerCase() ?? null,
      approved: false,
    });
  }

  if (ERROR_DETAIL_KEYS.some((key) => parsedUrl.searchParams.has(key))) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  if (typeof adminConsent !== 'string' || adminConsent.toLowerCase() !== 'true' || tenant === null) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  return Object.freeze({
    state,
    providerTenantReference: tenant.toLowerCase(),
    approved: true,
  });
}

function callbackFailure(error) {
  return CALLBACK_FAILURES.some((ErrorType) => error instanceof ErrorType);
}

function isMicrosoft365Path(path) {
  return Object.values(MICROSOFT365_ROUTES).includes(path);
}

export function microsoft365RouteKey(path) {
  if (path === MICROSOFT365_ROUTES.connection) return 'microsoft365_connection';
  if (path === MICROSOFT365_ROUTES.connect) return 'microsoft365_connect';
  if (path === MICROSOFT365_ROUTES.callback) return 'microsoft365_callback';
  if (path === MICROSOFT365_ROUTES.verify) return 'microsoft365_verify';
  if (path === MICROSOFT365_ROUTES.rooms) return 'microsoft365_rooms';
  return null;
}

export function createMicrosoft365HttpHandler({
  service,
  principalGuard,
  tenantGuard,
  maxResponseBytes,
} = {}) {
  if (!principalGuard || typeof principalGuard.require !== 'function') {
    throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  }
  if (!tenantGuard || typeof tenantGuard.requireKnown !== 'function') {
    throw new TypeError('TENANT_GUARD_REQUIRED');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
    throw new TypeError('MAX_RESPONSE_BYTES_INVALID');
  }

  return async function handleMicrosoft365({
    request,
    response,
    parsedUrl,
    path,
    requestId,
  }) {
    if (!isMicrosoft365Path(path)) return null;
    if (!service) throw new ApiError(503, 'MICROSOFT365_CONNECTION_SERVICE_UNAVAILABLE');

    if (path === MICROSOFT365_ROUTES.callback) {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      const principal = await principalGuard.require(request);
      const tenantContext = await tenantGuard.requireKnown(principal);
      const callback = callbackFromUrl(parsedUrl);
      try {
        const connection = await service.completeConsent({
          principal,
          tenantContext,
          correlationId: requestId,
          ...callback,
        });
        sendRedirect(
          response,
          CALLBACK_REDIRECTS[connection.status] || '/?integration=microsoft365_connection_failed',
        );
      } catch (error) {
        if (!callbackFailure(error)) throw error;
        sendRedirect(response, '/?integration=microsoft365_connection_failed');
      }
      return 303;
    }

    if (path === MICROSOFT365_ROUTES.rooms) {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      assertNoQuery(parsedUrl);
      if (typeof service.discoverRooms !== 'function') {
        throw new ApiError(503, 'MICROSOFT365_ROOM_DISCOVERY_UNAVAILABLE');
      }
      const principal = await principalGuard.require(request);
      const tenantContext = await tenantGuard.requireKnown(principal);
      const rooms = await service.discoverRooms({
        principal,
        tenantContext,
        correlationId: requestId,
      });
      sendJson(response, 200, { rooms, requestId }, maxResponseBytes);
      return 200;
    }

    const method = request.method;
    const allowed = path === MICROSOFT365_ROUTES.connection
      ? new Set(['GET', 'DELETE'])
      : new Set(['POST']);
    if (!allowed.has(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    assertNoQuery(parsedUrl);
    const mutation = method !== 'GET';
    const principal = await principalGuard.require(request, { csrf: mutation });
    const tenantContext = await tenantGuard.requireKnown(principal);
    if (mutation) await assertEmptyBody(request);

    if (path === MICROSOFT365_ROUTES.connection && method === 'GET') {
      const connection = await service.getConnection({
        principal,
        tenantContext,
        correlationId: requestId,
      });
      sendJson(response, 200, { connection, requestId }, maxResponseBytes);
      return 200;
    }
    if (path === MICROSOFT365_ROUTES.connect) {
      const started = await service.startConnection({
        principal,
        tenantContext,
        correlationId: requestId,
      });
      sendJson(response, 200, { ...started, requestId }, maxResponseBytes);
      return 200;
    }
    if (path === MICROSOFT365_ROUTES.verify) {
      const connection = await service.verifyConnection({
        principal,
        tenantContext,
        correlationId: requestId,
      });
      sendJson(response, 200, { connection, requestId }, maxResponseBytes);
      return 200;
    }

    const connection = await service.disconnect({
      principal,
      tenantContext,
      correlationId: requestId,
    });
    sendJson(response, 200, { connection, requestId }, maxResponseBytes);
    return 200;
  };
}
