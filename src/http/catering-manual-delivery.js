import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { readJsonObjectBody, validateExactObject } from '../security.js';
import { defineRouteModule } from './route-module.js';

function orderId(path) {
  const match = path.match(/^\/api\/v1\/tenant\/catering\/orders\/([0-9a-fA-F-]{36})\/manual-delivery$/u);
  return match && isInternalUuid(match[1]) ? match[1].toLowerCase() : null;
}
export function cateringManualRouteKey(path) { return orderId(path) === null ? null : 'catering_manual_detail'; }
async function emptyBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (Array.isArray(length) || !/^\d+$/u.test(length) || Number(length) !== 0)) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
}
function integer(value, minimum) {
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(value) || !Number.isSafeInteger(Number(value))
    || Number(value) < minimum || Number(value) >= Number.MAX_SAFE_INTEGER) throw new ApiError(400, 'VALIDATION_FAILED');
  return Number(value);
}
export function createCateringManualDeliveryHttpHandler({ service = null, principalGuard, tenantGuard,
  maxBodyBytes, maxResponseBytes } = {}) {
  if (service !== null && !['load','record'].every((key) => typeof service[key] === 'function')) {
    throw new TypeError('CATERING_MANUAL_SERVICE_INVALID');
  }
  if (typeof principalGuard?.require !== 'function' || typeof tenantGuard?.requireActive !== 'function'
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new TypeError('CATERING_MANUAL_HTTP_PORT_INVALID');
  return async ({ request, response, path, parsedUrl, requestId }) => {
    const selected = orderId(path); if (selected === null) return null;
    if (!service) throw new ApiError(503, 'CATERING_MANUAL_UNAVAILABLE');
    const principal = await principalGuard.require(request, { csrf: ['POST','PUT','PATCH','DELETE'].includes(request.method) });
    const tenantContext = await tenantGuard.requireActive(principal);
    const context = { principal, tenantContext, correlationId: requestId, orderId: selected };
    if (!['GET','POST'].includes(request.method)) {
      response.setHeader('Allow', 'GET, POST'); throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    const query = [...parsedUrl.searchParams.entries()]; let value;
    if (request.method === 'GET') {
      if (query.length > 2 || new Set(query.map(([key]) => key)).size !== query.length
        || query.some(([key]) => !['orderVersion','afterSequence'].includes(key))) throw new ApiError(400, 'VALIDATION_FAILED');
      const parameters = Object.fromEntries(query);
      await emptyBody(request);
      value = await service.load({ ...context,
        orderVersion: parameters.orderVersion === undefined ? null : integer(parameters.orderVersion, 1),
        afterSequence: parameters.afterSequence === undefined ? 0 : integer(parameters.afterSequence, 0) });
    } else {
      if (query.length !== 0) throw new ApiError(400, 'VALIDATION_FAILED');
      const body = validateExactObject(await readJsonObjectBody(request, { maxBytes: Math.min(maxBodyBytes, 40960) }), {
        required: { schemaVersion: Number.isSafeInteger, commandId: isInternalUuid, expectedOrderVersion: Number.isSafeInteger,
          expectedStateRevision: Number.isSafeInteger, kind: (entry) => typeof entry === 'string',
          channel: (entry) => typeof entry === 'string', reference: (entry) => typeof entry === 'string',
          occurredAt: (entry) => typeof entry === 'string',
          receipt: (entry) => entry === null || (typeof entry === 'object' && !Array.isArray(entry)) }, optional: {},
      });
      value = await service.record({ ...context, ...body });
    }
    const body = JSON.stringify(value); const bytes = Buffer.byteLength(body);
    if (bytes > Math.min(maxResponseBytes, 737280)) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
    response.statusCode = 200; response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', bytes); response.end(body); return 200;
  };
}
export function createCateringManualDeliveryRouteModule(service) {
  return defineRouteModule({ id: 'catering-manual-delivery', routeKey: cateringManualRouteKey,
    createHandler(runtime) {
      return createCateringManualDeliveryHttpHandler({ service, principalGuard: runtime?.principalGuard, tenantGuard: runtime?.tenantGuard,
        maxBodyBytes: runtime?.maxBodyBytes, maxResponseBytes: runtime?.maxResponseBytes });
    } });
}
