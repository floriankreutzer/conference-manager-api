import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { readJsonObjectBody, validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ROOT = '/api/v1/tenant/catering/delivery-jobs';
function resource(path) {
  if (path === ROOT) return { kind: 'collection', jobId: null };
  const match = path.match(/^\/api\/v1\/tenant\/catering\/delivery-jobs\/([0-9a-fA-F-]{36})$/);
  return match && isInternalUuid(match[1]) ? { kind: 'detail', jobId: match[1].toLowerCase() } : null;
}
export function cateringDeliveryRouteKey(path) {
  const selected = resource(path);
  return selected ? `catering_delivery_${selected.kind}` : null;
}
async function emptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
}
export function createCateringDeliveryHttpHandler({ service = null, principalGuard, tenantGuard,
  maxBodyBytes, maxResponseBytes } = {}) {
  if (service !== null && !['load','list','enqueue'].every((key) => typeof service[key] === 'function')) {
    throw new TypeError('CATERING_DELIVERY_SERVICE_INVALID');
  }
  if (!principalGuard || typeof principalGuard.require !== 'function') throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  if (!tenantGuard || typeof tenantGuard.requireActive !== 'function') throw new TypeError('TENANT_GUARD_REQUIRED');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || !Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes < 1024) throw new TypeError('CATERING_DELIVERY_HTTP_BOUNDS_INVALID');
  return async ({ request, response, path, parsedUrl, requestId }) => {
    const selected = resource(path);
    if (!selected) return null;
    if (!service) throw new ApiError(503, 'CATERING_DELIVERY_UNAVAILABLE');
    const principal = await principalGuard.require(request, { csrf: ['POST','PUT','PATCH','DELETE'].includes(request.method) });
    const tenantContext = await tenantGuard.requireActive(principal);
    const context = { principal, tenantContext, correlationId: requestId };
    const allowed = selected.kind === 'collection' ? ['GET','POST'] : ['GET'];
    if (!allowed.includes(request.method)) {
      response.setHeader('Allow', allowed.join(', ')); throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    const query = [...parsedUrl.searchParams.entries()];
    let value;
    if (selected.kind === 'collection' && request.method === 'GET') {
      if (query.length > 2 || new Set(query.map(([key]) => key)).size !== query.length
        || query.some(([key, entry]) => !['afterJobId','orderId'].includes(key) || !isInternalUuid(entry))) {
        throw new ApiError(400, 'VALIDATION_FAILED');
      }
      await emptyBody(request);
      const parameters = Object.fromEntries(query);
      value = await service.list({ ...context, afterJobId: parameters.afterJobId ?? null, orderId: parameters.orderId ?? null });
    } else {
      if (query.length !== 0) throw new ApiError(400, 'VALIDATION_FAILED');
      if (selected.kind === 'detail') {
        await emptyBody(request); value = await service.load({ ...context, jobId: selected.jobId });
      } else {
        const body = validateExactObject(await readJsonObjectBody(request, { maxBytes: Math.min(maxBodyBytes, 4096) }), {
          required: { schemaVersion: Number.isSafeInteger, orderId: isInternalUuid, expectedOrderVersion: Number.isSafeInteger,
            expectedStateRevision: Number.isSafeInteger, expectedQuoteRevision: Number.isSafeInteger }, optional: {},
        });
        value = await service.enqueue({ ...context, ...body });
      }
    }
    const body = JSON.stringify(value); const bytes = Buffer.byteLength(body);
    if (bytes > Math.min(maxResponseBytes, 65536)) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
    response.statusCode = 200; response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', bytes); response.end(body); return 200;
  };
}
export function createCateringDeliveryRouteModule(service) {
  return defineRouteModule({ id: 'catering-delivery-jobs', routeKey: cateringDeliveryRouteKey,
    createHandler(runtime) {
      return createCateringDeliveryHttpHandler({ service, principalGuard: runtime?.principalGuard, tenantGuard: runtime?.tenantGuard,
        maxBodyBytes: runtime?.config?.maxBodyBytes, maxResponseBytes: runtime?.config?.maxResponseBytes });
    } });
}
