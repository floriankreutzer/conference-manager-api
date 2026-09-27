import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isSupportedRequestCompositionSchemaVersion } from '../domain/request-composition.js';
import { readJsonObjectBody, validateExactObject } from '../security.js';

export const APPLICATION_ROUTES = Object.freeze({
  profile: '/api/v1/application/profile',
  catalog: '/api/v1/application/catalog',
  siteInfo: '/api/v1/application/site-info',
  requests: '/api/v1/application/requests',
  requestReport: '/api/v1/application/reports/requests',
  roomAvailability: '/api/v1/application/room-availability',
  notifications: '/api/v1/application/notifications',
  configuration: '/api/v1/application/configuration',
});

const NOTIFICATION_PATH = /^\/api\/v1\/application\/notifications\/([0-9a-f-]{36})$/i;
const CATALOG_QUERY_KEYS = new Set(['section', 'limit', 'cursor', 'context']);
const REQUEST_LIST_QUERY_KEYS = new Set(['limit', 'cursor']);
const REQUEST_REPORT_QUERY_KEYS = new Set(['from', 'to', 'limit', 'cursor']);
const REQUEST_RESUBMISSION_PATH = new RegExp(
  '^/api/v1/application/requests/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/resubmissions$',
);
const PROFILE_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    displayName: (value) => {
      if (typeof value !== 'string') return false;
      const length = Array.from(value.trim().normalize('NFC')).length;
      return length >= 1 && length <= 160;
    },
  }),
  optional: Object.freeze({}),
});
const REQUEST_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    schemaVersion: isSupportedRequestCompositionSchemaVersion,
    request: (value) => value && typeof value === 'object' && !Array.isArray(value),
  }),
  optional: Object.freeze({}),
});
const REQUEST_RESUBMISSION_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    schemaVersion: isSupportedRequestCompositionSchemaVersion,
    expectedVersion: (value) => Number.isSafeInteger(value)
      && value >= 1
      && value < Number.MAX_SAFE_INTEGER,
    request: (value) => value && typeof value === 'object' && !Array.isArray(value),
  }),
  optional: Object.freeze({}),
});
const ROOM_AVAILABILITY_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    roomId: (value) => typeof value === 'string' && value.length >= 1 && value.length <= 128,
    startsAt: (value) => typeof value === 'string' && value.length <= 64,
    endsAt: (value) => typeof value === 'string' && value.length <= 64,
  }),
  optional: Object.freeze({
    resubmissionRequestId: (value) => typeof value === 'string' && value.length >= 1 && value.length <= 128,
  }),
});
const NOTIFICATION_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({ read: (value) => value === true }),
  optional: Object.freeze({}),
});
function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify({ schemaVersion: 1, ...payload });
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
}

function requestReportQuery(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (
      !REQUEST_REPORT_QUERY_KEYS.has(key)
      || parsedUrl.searchParams.getAll(key).length !== 1
    ) throw new ApiError(400, 'VALIDATION_FAILED');
  }
  const from = parsedUrl.searchParams.get('from');
  const to = parsedUrl.searchParams.get('to');
  const limit = parsedUrl.searchParams.get('limit');
  const cursor = parsedUrl.searchParams.get('cursor');
  if (
    typeof from !== 'string'
    || from.length > 64
    || typeof to !== 'string'
    || to.length > 64
    || (limit !== null && limit.length > 3)
    || (cursor !== null && cursor.length > 1_024)
  ) throw new ApiError(400, 'VALIDATION_FAILED');
  return Object.freeze({
    from,
    to,
    limit: limit ?? undefined,
    cursor: cursor ?? undefined,
  });
}

function catalogQuery(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (
      !CATALOG_QUERY_KEYS.has(key)
      || parsedUrl.searchParams.getAll(key).length !== 1
    ) throw new ApiError(400, 'VALIDATION_FAILED');
  }
  const section = parsedUrl.searchParams.get('section');
  const limit = parsedUrl.searchParams.get('limit');
  const cursor = parsedUrl.searchParams.get('cursor');
  const context = parsedUrl.searchParams.get('context');
  if (
    typeof section !== 'string'
    || section.length > 32
    || (limit !== null && limit.length > 2)
    || (cursor !== null && cursor.length > 2_048)
    || (context !== null && context.length > 2_048)
  ) throw new ApiError(400, 'VALIDATION_FAILED');
  return Object.freeze({
    section,
    limit: limit ?? undefined,
    cursor: cursor ?? undefined,
    context: context ?? undefined,
  });
}

function requestListQuery(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (
      !REQUEST_LIST_QUERY_KEYS.has(key)
      || parsedUrl.searchParams.getAll(key).length !== 1
    ) throw new ApiError(400, 'VALIDATION_FAILED');
  }
  const limit = parsedUrl.searchParams.get('limit');
  const cursor = parsedUrl.searchParams.get('cursor');
  if (
    (limit !== null && limit.length > 2)
    || (cursor !== null && cursor.length > 2_048)
  ) throw new ApiError(400, 'VALIDATION_FAILED');
  return Object.freeze({
    limit: limit ?? undefined,
    cursor: cursor ?? undefined,
  });
}

function notificationId(path) {
  const match = path.match(NOTIFICATION_PATH);
  if (!match || !isInternalUuid(match[1])) throw new ApiError(404, 'NOT_FOUND');
  return match[1].toLowerCase();
}

export function applicationRouteKey(path) {
  if (path === APPLICATION_ROUTES.profile) return 'application_profile';
  if (path === APPLICATION_ROUTES.catalog) return 'application_catalog';
  if (path === APPLICATION_ROUTES.siteInfo) return 'application_site_info';
  if (path === APPLICATION_ROUTES.requests) return 'application_requests';
  if (path === APPLICATION_ROUTES.requestReport) return 'application_request_report';
  if (path === APPLICATION_ROUTES.roomAvailability) return 'application_room_availability';
  if (path === APPLICATION_ROUTES.notifications) return 'application_notifications';
  if (path === APPLICATION_ROUTES.configuration) return 'application_configuration';
  if (REQUEST_RESUBMISSION_PATH.test(path)) return 'application_request_resubmission';
  if (NOTIFICATION_PATH.test(path)) return 'application_notification';
  return null;
}

export function createApplicationHttpHandler({
  service,
  principalGuard,
  tenantGuard,
  maxBodyBytes,
  maxResponseBytes,
} = {}) {
  if (!principalGuard || typeof principalGuard.require !== 'function') {
    throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  }
  if (
    !tenantGuard
    || typeof tenantGuard.requireKnown !== 'function'
    || typeof tenantGuard.requireActive !== 'function'
  ) {
    throw new TypeError('TENANT_GUARD_REQUIRED');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024) throw new TypeError('MAX_BODY_BYTES_INVALID');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
    throw new TypeError('MAX_RESPONSE_BYTES_INVALID');
  }
  return async function handleApplication({ request, response, parsedUrl, path, requestId }) {
    if (!applicationRouteKey(path)) return null;
    if (!service) throw new ApiError(503, 'APPLICATION_SERVICE_UNAVAILABLE');
    if (![
      APPLICATION_ROUTES.catalog,
      APPLICATION_ROUTES.requests,
      APPLICATION_ROUTES.requestReport,
    ].includes(path)) {
      assertNoQuery(parsedUrl);
    }

    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    const principal = await principalGuard.require(request, { csrf: mutation });
    const knownTenantRoutes = new Set([
      APPLICATION_ROUTES.profile,
      APPLICATION_ROUTES.catalog,
      APPLICATION_ROUTES.siteInfo,
      APPLICATION_ROUTES.configuration,
    ]);
    const tenantContext = knownTenantRoutes.has(path)
      ? await tenantGuard.requireKnown(principal)
      : await tenantGuard.requireActive(principal);
    const common = { principal, tenantContext, correlationId: requestId };

    if (path === APPLICATION_ROUTES.profile) {
      if (request.method === 'GET') {
        sendJson(response, 200, { profile: await service.getProfile(common) }, maxResponseBytes);
        return 200;
      }
      if (request.method === 'PUT') {
        const profile = validateExactObject(
          await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
          PROFILE_BODY_SCHEMA,
        );
        sendJson(response, 200, {
          profile: await service.updateProfile({ ...common, profile }),
        }, maxResponseBytes);
        return 200;
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }

    if (path === APPLICATION_ROUTES.catalog) {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      sendJson(
        response,
        200,
        await service.getCatalog({ ...common, query: catalogQuery(parsedUrl) }),
        maxResponseBytes,
      );
      return 200;
    }

    if (path === APPLICATION_ROUTES.siteInfo) {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      sendJson(response, 200, { siteInfo: await service.getSiteInfo(common) }, maxResponseBytes);
      return 200;
    }

    if (path === APPLICATION_ROUTES.requests) {
      if (request.method === 'GET') {
        sendJson(response, 200, await service.listRequests({
          ...common,
          query: requestListQuery(parsedUrl),
        }), maxResponseBytes);
        return 200;
      }
      if (request.method === 'POST') {
        assertNoQuery(parsedUrl);
        const body = validateExactObject(
          await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
          REQUEST_BODY_SCHEMA,
        );
        sendJson(response, 201, {
          schemaVersion: 3,
          request: await service.createRequest({
            ...common,
            schemaVersion: body.schemaVersion,
            requestDraft: body.request,
          }),
          requestId,
        }, maxResponseBytes);
        return 201;
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }

    if (path === APPLICATION_ROUTES.requestReport) {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      sendJson(response, 200, await service.getRequestReport({
          ...common,
          query: requestReportQuery(parsedUrl),
        }), maxResponseBytes);
      return 200;
    }

    const resubmissionMatch = path.match(REQUEST_RESUBMISSION_PATH);
    if (resubmissionMatch) {
      if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      const body = validateExactObject(
        await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
        REQUEST_RESUBMISSION_BODY_SCHEMA,
      );
      sendJson(response, 200, {
        schemaVersion: 3,
        request: await service.resubmitRequest({
          ...common,
          requestId: resubmissionMatch[1],
          schemaVersion: body.schemaVersion,
          expectedVersion: body.expectedVersion,
          requestDraft: body.request,
        }),
        requestId,
      }, maxResponseBytes);
      return 200;
    }

    if (path === APPLICATION_ROUTES.roomAvailability) {
      if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      const query = validateExactObject(
        await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
        ROOM_AVAILABILITY_BODY_SCHEMA,
      );
      sendJson(response, 200, {
        availability: await service.checkRoomAvailability({ ...common, query }),
      }, maxResponseBytes);
      return 200;
    }

    if (path === APPLICATION_ROUTES.notifications) {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      sendJson(response, 200, { notifications: await service.listNotifications(common) }, maxResponseBytes);
      return 200;
    }

    if (NOTIFICATION_PATH.test(path)) {
      if (request.method !== 'PATCH') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      validateExactObject(
        await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
        NOTIFICATION_BODY_SCHEMA,
      );
      sendJson(response, 200, {
        notification: await service.markNotificationRead({
          ...common,
          notificationId: notificationId(path),
        }),
      }, maxResponseBytes);
      return 200;
    }

    if (path === APPLICATION_ROUTES.configuration) {
      if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      sendJson(response, 200, { configuration: await service.getConfiguration(common) }, maxResponseBytes);
      return 200;
    }

    return null;
  };
}
