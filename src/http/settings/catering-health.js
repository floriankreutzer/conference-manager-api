import { ApiError } from '../../api-error.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { defineRouteModule } from '../route-module.js';

function integrationId(path) {
  const match = typeof path === 'string' ? path.match(/^\/api\/v1\/integrations\/catering\/([0-9a-fA-F-]{36})\/health$/u) : null;
  return match && isInternalUuid(match[1]) ? match[1].toLowerCase() : null;
}
export function cateringOperationalHealthRouteKey(path) { return integrationId(path) === null ? null : 'catering_health'; }
async function emptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/u.test(length) || Number(length) !== 0)) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
}
export function createCateringOperationalHealthHttpHandler({ service = null, principalGuard, tenantGuard, maxResponseBytes } = {}) {
  if (service !== null && typeof service?.current !== 'function') throw new TypeError('CATERING_HEALTH_SERVICE_REQUIRED');
  if (typeof principalGuard?.require !== 'function' || typeof tenantGuard?.requireKnown !== 'function'
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new TypeError('CATERING_HEALTH_HTTP_PORT_REQUIRED');
  return async ({ request, response, path, parsedUrl, requestId }) => {
    const selected = integrationId(path); if (selected === null) return null;
    if (!service) throw new ApiError(503, 'CATERING_HEALTH_UNAVAILABLE');
    const principal = await principalGuard.require(request, { csrf: ['POST','PUT','PATCH','DELETE'].includes(request.method) });
    const tenantContext = await tenantGuard.requireKnown(principal);
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw new ApiError(405, 'METHOD_NOT_ALLOWED'); }
    if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
    await emptyBody(request);
    const value = await service.current({ principal, tenantContext, correlationId: requestId, integrationId: selected });
    const body = JSON.stringify(value); const length = Buffer.byteLength(body);
    if (length > Math.min(maxResponseBytes,16384)) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
    response.statusCode = 200; response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', length); response.end(body); return 200;
  };
}
export function createCateringOperationalHealthRouteModule(service) {
  return defineRouteModule({ id: 'catering-operational-health', routeKey: cateringOperationalHealthRouteKey,
    createHandler(runtime) {
      return createCateringOperationalHealthHttpHandler({ service, principalGuard: runtime?.principalGuard,
        tenantGuard: runtime?.tenantGuard, maxResponseBytes: runtime?.maxResponseBytes });
    } });
}
