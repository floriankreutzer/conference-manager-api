import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { readJsonObjectBody, validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ASSIGNMENTS = '/api/v1/tenant/catering/catalogue-assignments';
const CONNECTIONS = '/api/v1/tenant/catering/catalogue-connections';
const SCHEMA = Object.freeze({ required: Object.freeze({
  schemaVersion: Number.isSafeInteger, expectedRevision: Number.isSafeInteger, catalogueRevision: Number.isSafeInteger,
  assignments: (value) => Array.isArray(value) && value.length <= 400,
}), optional: Object.freeze({}) });

export function cateringCatalogueAssignmentRouteKey(path) {
  if (path === ASSIGNMENTS) return 'catering_catalogue_assignments';
  return path === CONNECTIONS ? 'catering_catalogue_connections' : null;
}
async function emptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
}
export function createCateringCatalogueAssignmentHttpHandler({
  service = null, principalGuard, tenantGuard, maxBodyBytes, maxResponseBytes,
} = {}) {
  if (service !== null && !['current', 'replace', 'listConnections'].every((name) => typeof service[name] === 'function')) {
    throw new TypeError('CATERING_ASSIGNMENT_SERVICE_INVALID');
  }
  if (!principalGuard || typeof principalGuard.require !== 'function') throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  if (!tenantGuard || typeof tenantGuard.requireActive !== 'function') throw new TypeError('TENANT_GUARD_REQUIRED');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new TypeError('CATERING_ASSIGNMENT_HTTP_BOUNDS_INVALID');
  return async ({ request, response, path, parsedUrl, requestId }) => {
    if (!cateringCatalogueAssignmentRouteKey(path)) return null;
    if (!service) throw new ApiError(503, 'CATERING_ASSIGNMENT_UNAVAILABLE');
    const principal = await principalGuard.require(request, { csrf: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) });
    const tenantContext = await tenantGuard.requireActive(principal);
    const context = { principal, tenantContext, correlationId: requestId };
    const query = [...parsedUrl.searchParams.entries()];
    let value;
    if (path === CONNECTIONS) {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      }
      if (query.length > 1 || (query.length === 1 && (query[0][0] !== 'afterIntegrationId' || !isInternalUuid(query[0][1])))) {
        throw new ApiError(400, 'VALIDATION_FAILED');
      }
      await emptyBody(request);
      value = await service.listConnections({ ...context, afterIntegrationId: query[0]?.[1] ?? null });
    } else {
      if (query.length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
      if (request.method === 'GET') {
        await emptyBody(request);
        value = await service.current(context);
      } else if (request.method === 'PUT') {
        const body = validateExactObject(await readJsonObjectBody(request, { maxBytes: Math.min(maxBodyBytes, 131072) }), SCHEMA);
        value = await service.replace({ ...context, ...body });
      } else {
        response.setHeader('Allow', 'GET, PUT');
        throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      }
    }
    const body = JSON.stringify(value);
    const length = Buffer.byteLength(body);
    if (length > Math.min(maxResponseBytes, 262144)) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', length);
    response.end(body);
    return 200;
  };
}
export function createCateringCatalogueAssignmentRouteModule(service) {
  return defineRouteModule({ id: 'catering-catalogue-assignments', routeKey: cateringCatalogueAssignmentRouteKey,
    createHandler(runtime) {
      return createCateringCatalogueAssignmentHttpHandler({ service,
        principalGuard: runtime?.principalGuard, tenantGuard: runtime?.tenantGuard,
        maxBodyBytes: runtime?.maxBodyBytes, maxResponseBytes: runtime?.maxResponseBytes });
    },
  });
}
