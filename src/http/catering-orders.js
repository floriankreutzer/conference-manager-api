import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import { readJsonObjectBody, validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ROOT = '/api/v1/tenant/catering/orders';
const SCHEMAS = Object.freeze({
  prepare: { required: { schemaVersion: Number.isSafeInteger, requestId: isRequestId, commandId: isInternalUuid,
    expectedRequestVersion: Number.isSafeInteger, expectedAssignmentRevision: Number.isSafeInteger }, optional: {} },
  quote: { required: { schemaVersion: Number.isSafeInteger, expectedStateRevision: Number.isSafeInteger,
    expectedQuoteRevision: Number.isSafeInteger, cost: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    expiresAt: (value) => typeof value === 'string' }, optional: { expectedOrderVersion: Number.isSafeInteger } },
  decision: { required: { schemaVersion: Number.isSafeInteger, expectedStateRevision: Number.isSafeInteger,
    expectedQuoteRevision: Number.isSafeInteger, decision: (value) => ['approved','rejected'].includes(value) },
    optional: { expectedOrderVersion: Number.isSafeInteger } },
});
function resource(path) {
  if (path === ROOT) return { kind: 'collection', orderId: null };
  const match = path.match(/^\/api\/v1\/tenant\/catering\/orders\/([0-9a-fA-F-]{36})(?:\/(quote|decision))?$/);
  return match && isInternalUuid(match[1]) ? { kind: match[2] ?? 'detail', orderId: match[1].toLowerCase() } : null;
}
export function cateringOrderRouteKey(path) {
  const selected = resource(path);
  return selected ? `catering_order_${selected.kind}` : null;
}
async function emptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
}
export function createCateringOrderHttpHandler({ service = null, principalGuard, tenantGuard, maxBodyBytes, maxResponseBytes } = {}) {
  if (service !== null && !['load','list','prepare','recordQuote','decide'].every((name) => typeof service[name] === 'function')) {
    throw new TypeError('CATERING_ORDER_SERVICE_INVALID');
  }
  if (!principalGuard || typeof principalGuard.require !== 'function') throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  if (!tenantGuard || typeof tenantGuard.requireActive !== 'function') throw new TypeError('TENANT_GUARD_REQUIRED');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || !Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes < 1024) throw new TypeError('CATERING_ORDER_HTTP_BOUNDS_INVALID');
  return async ({ request, response, path, parsedUrl, requestId }) => {
    const selected = resource(path);
    if (!selected) return null;
    if (!service) throw new ApiError(503, 'CATERING_ORDER_UNAVAILABLE');
    const principal = await principalGuard.require(request, { csrf: ['POST','PUT','PATCH','DELETE'].includes(request.method) });
    const tenantContext = await tenantGuard.requireActive(principal);
    const context = { principal, tenantContext, correlationId: requestId };
    const query = [...parsedUrl.searchParams.entries()];
    const allowed = selected.kind === 'collection' ? ['GET','POST'] : selected.kind === 'detail' ? ['GET']
      : selected.kind === 'quote' ? ['PUT'] : ['POST'];
    if (!allowed.includes(request.method)) {
      response.setHeader('Allow', allowed.join(', '));
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    let value;
    if (selected.kind === 'collection' && request.method === 'GET') {
      if (query.length > 2 || new Set(query.map(([key]) => key)).size !== query.length
        || query.some(([key, entry]) => key === 'afterOrderId' ? !isInternalUuid(entry) : key !== 'requestId' || !isRequestId(entry))) {
        throw new ApiError(400, 'VALIDATION_FAILED');
      }
      await emptyBody(request);
      const parameters = Object.fromEntries(query);
      value = await service.list({ ...context, afterOrderId: parameters.afterOrderId ?? null, requestId: parameters.requestId ?? null });
    } else {
      if (selected.kind === 'detail') {
        if (query.length > 1 || query.some(([key, entry]) => key !== 'orderVersion' || !/^[1-9]\d{0,15}$/u.test(entry)
          || !Number.isSafeInteger(Number(entry)) || Number(entry) >= Number.MAX_SAFE_INTEGER)) {
          throw new ApiError(400, 'VALIDATION_FAILED');
        }
        await emptyBody(request);
        value = await service.load({ ...context, orderId: selected.orderId,
          ...(query.length === 0 ? {} : { orderVersion: Number(query[0][1]) }) });
      } else {
        if (query.length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
        const command = selected.kind === 'collection' ? 'prepare' : selected.kind;
        const body = validateExactObject(await readJsonObjectBody(request, { maxBytes: Math.min(maxBodyBytes, 4096) }), SCHEMAS[command]);
        if (command === 'prepare') value = await service.prepare({ ...context, ...body });
        else if (command === 'quote') value = await service.recordQuote({ ...context, ...body, orderId: selected.orderId });
        else value = await service.decide({ ...context, ...body, orderId: selected.orderId });
      }
    }
    const body = JSON.stringify(value);
    const bytes = Buffer.byteLength(body);
    const ceiling = selected.kind === 'collection' ? 65536 : 524288;
    if (bytes > Math.min(maxResponseBytes, ceiling)) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', bytes);
    response.end(body);
    return 200;
  };
}
export function createCateringOrderRouteModule(service) {
  return defineRouteModule({ id: 'catering-orders', routeKey: cateringOrderRouteKey,
    createHandler(runtime) {
      return createCateringOrderHttpHandler({ service, principalGuard: runtime?.principalGuard, tenantGuard: runtime?.tenantGuard,
        maxBodyBytes: runtime?.maxBodyBytes, maxResponseBytes: runtime?.maxResponseBytes });
    } });
}
