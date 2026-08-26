import { ApiError } from '../api-error.js';
import {
  readJsonObjectBody,
  validateExactObject,
} from '../security.js';

const UPDATE_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    expectedRevision: (value) => Number.isSafeInteger(value) && value >= 0,
    configuration: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  }),
  optional: Object.freeze({}),
});
const ROLLBACK_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    expectedRevision: (value) => Number.isSafeInteger(value) && value >= 1,
  }),
  optional: Object.freeze({}),
});
const HISTORY_QUERY_KEYS = new Set(['limit']);

function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

async function assertEmptyBody(request) {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    if (Array.isArray(contentLength) || !/^\d+$/.test(contentLength) || Number(contentLength) !== 0) {
      throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
    }
  }
  for await (const chunk of request) {
    if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
}

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
}

function historyLimit(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!HISTORY_QUERY_KEYS.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
  const raw = parsedUrl.searchParams.get('limit');
  if (raw === null) return 50;
  if (!/^\d{1,3}$/.test(raw)) throw new ApiError(400, 'VALIDATION_FAILED');
  const limit = Number(raw);
  if (limit < 1 || limit > 100) throw new ApiError(400, 'VALIDATION_FAILED');
  return limit;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createTenantConfigurationRouteContract(basePath) {
  if (typeof basePath !== 'string' || !/^\/api\/v1\/tenant\/[a-z][a-z-]{0,63}$/.test(basePath)) {
    throw new TypeError('TENANT_CONFIGURATION_BASE_PATH_INVALID');
  }
  const prefix = escaped(basePath);
  const historyPath = `${basePath}/history`;
  const revisionPattern = new RegExp(`^${prefix}/revisions/(\\d+)$`);
  const rollbackPattern = new RegExp(`^${prefix}/revisions/(\\d+)/rollback$`);

  return Object.freeze({
    routeKey(path) {
      if (path === basePath) return 'application_configuration';
      if (path === historyPath) return 'application_configuration';
      if (revisionPattern.test(path)) return 'application_configuration';
      if (rollbackPattern.test(path)) return 'application_configuration';
      return null;
    },

    createHandler({
      service,
      principalGuard,
      tenantGuard,
      maxBodyBytes,
      maxResponseBytes,
    } = {}) {
      if (!principalGuard || typeof principalGuard.require !== 'function') {
        throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
      }
      if (!tenantGuard || typeof tenantGuard.requireKnown !== 'function') {
        throw new TypeError('TENANT_GUARD_REQUIRED');
      }
      if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024) {
        throw new TypeError('MAX_BODY_BYTES_INVALID');
      }
      if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
        throw new TypeError('MAX_RESPONSE_BYTES_INVALID');
      }

      return async function handleTenantConfiguration({
        request,
        response,
        parsedUrl,
        path,
        requestId,
      }) {
        const revisionMatch = path.match(revisionPattern);
        const rollbackMatch = path.match(rollbackPattern);
        const recognized = path === basePath
          || path === historyPath
          || revisionMatch
          || rollbackMatch;
        if (!recognized) return null;
        if (!service) throw new ApiError(503, 'TENANT_CONFIGURATION_SERVICE_UNAVAILABLE');

        const mutation = request.method === 'PUT' || request.method === 'POST';
        const principal = await principalGuard.require(request, { csrf: mutation });
        const tenantContext = await tenantGuard.requireKnown(principal);

        if (path === basePath) {
          if (request.method === 'GET') {
            assertNoQuery(parsedUrl);
            await assertEmptyBody(request);
            const result = await service.getCurrent({ principal, tenantContext, correlationId: requestId });
            sendJson(response, 200, { schemaVersion: 1, result, requestId }, maxResponseBytes);
            return 200;
          }
          if (request.method !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          assertNoQuery(parsedUrl);
          const body = validateExactObject(
            await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
            UPDATE_BODY_SCHEMA,
          );
          const result = await service.update({
            principal,
            tenantContext,
            correlationId: requestId,
            expectedRevision: body.expectedRevision,
            configuration: body.configuration,
          });
          sendJson(response, 200, { schemaVersion: 1, result, requestId }, maxResponseBytes);
          return 200;
        }

        if (path === historyPath) {
          if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          await assertEmptyBody(request);
          const revisions = await service.listHistory({
            principal,
            tenantContext,
            correlationId: requestId,
            limit: historyLimit(parsedUrl),
          });
          sendJson(response, 200, { schemaVersion: 1, revisions, requestId }, maxResponseBytes);
          return 200;
        }

        if (revisionMatch) {
          if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          assertNoQuery(parsedUrl);
          await assertEmptyBody(request);
          const result = await service.getRevision({
            principal,
            tenantContext,
            correlationId: requestId,
            revision: revisionMatch[1],
          });
          sendJson(response, 200, { schemaVersion: 1, result, requestId }, maxResponseBytes);
          return 200;
        }

        if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        assertNoQuery(parsedUrl);
        const body = validateExactObject(
          await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
          ROLLBACK_BODY_SCHEMA,
        );
        const result = await service.rollback({
          principal,
          tenantContext,
          correlationId: requestId,
          expectedRevision: body.expectedRevision,
          sourceRevision: rollbackMatch[1],
        });
        sendJson(response, 200, { schemaVersion: 1, result, requestId }, maxResponseBytes);
        return 200;
      };
    },
  });
}
