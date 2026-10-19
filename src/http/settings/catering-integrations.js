import { ApiError } from '../../api-error.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { readJsonObjectBody, validateExactObject } from '../../security.js';
import { defineRouteModule } from '../route-module.js';

const PATH = /^\/api\/v1\/integrations\/catering\/([^/]+)\/configuration$/;
const BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    schemaVersion: Number.isSafeInteger,
    expectedRevision: Number.isSafeInteger,
    configuration: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  }),
  optional: Object.freeze({}),
});

function integrationIdFrom(path) {
  const match = typeof path === 'string' ? path.match(PATH) : null;
  return match && isInternalUuid(match[1]) ? match[1].toLowerCase() : null;
}

export function cateringConfigurationRouteKey(path) {
  return integrationIdFrom(path) ? 'catering_configuration' : null;
}

async function requireEmptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) {
    if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
}

export function createCateringConfigurationHttpHandler({
  service = null, principalGuard, tenantGuard, maxBodyBytes, maxResponseBytes,
} = {}) {
  if (service !== null && !['current', 'update'].every((name) => typeof service[name] === 'function')) {
    throw new TypeError('CATERING_CONFIGURATION_SERVICE_INVALID');
  }
  if (!principalGuard || typeof principalGuard.require !== 'function') throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  if (!tenantGuard || typeof tenantGuard.requireKnown !== 'function') throw new TypeError('TENANT_GUARD_REQUIRED');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new TypeError('MAX_BODY_BYTES_INVALID');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new TypeError('MAX_RESPONSE_BYTES_INVALID');
  const bodyLimit = Math.min(maxBodyBytes, 8192);
  const responseLimit = Math.min(maxResponseBytes, 16384);

  return async ({ request, response, parsedUrl, path, requestId }) => {
    const integrationId = integrationIdFrom(path);
    if (!integrationId) return null;
    if (!service) throw new ApiError(503, 'CATERING_CONFIGURATION_UNAVAILABLE');
    const mutation = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method);
    const principal = await principalGuard.require(request, { csrf: mutation });
    const tenantContext = await tenantGuard.requireKnown(principal);
    if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
    const common = { principal, tenantContext, integrationId, correlationId: requestId };
    let result;
    if (request.method === 'GET') {
      await requireEmptyBody(request);
      result = await service.current(common);
    } else if (request.method === 'PUT') {
      const body = validateExactObject(await readJsonObjectBody(request, { maxBytes: bodyLimit }), BODY_SCHEMA);
      result = await service.update({ ...common, ...body });
    } else {
      response.setHeader('Allow', 'GET, PUT');
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    const body = JSON.stringify(result);
    const length = Buffer.byteLength(body);
    if (length > responseLimit) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', length);
    response.end(body);
    return 200;
  };
}

export const cateringConfigurationRouteModule = defineRouteModule({
  id: 'catering-configuration', routeKey: cateringConfigurationRouteKey,
  createHandler(runtime) {
    return createCateringConfigurationHttpHandler({
      service: runtime?.cateringConfigurationService, principalGuard: runtime?.principalGuard, tenantGuard: runtime?.tenantGuard,
      maxBodyBytes: runtime?.maxBodyBytes, maxResponseBytes: runtime?.maxResponseBytes,
    });
  },
});
