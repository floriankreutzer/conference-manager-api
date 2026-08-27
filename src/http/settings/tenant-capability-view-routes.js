import { ApiError } from '../../api-error.js';
import { defineRouteModule } from '../route-module.js';

const CAPABILITIES_PATH = '/api/v1/tenant/capabilities';

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
  if (
    contentLength !== undefined
    && (
      Array.isArray(contentLength)
      || !/^\d+$/.test(contentLength)
      || Number(contentLength) !== 0
    )
  ) {
    throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) {
    if (chunk.length > 0) throw new ApiError(400, 'REQUEST_BODY_NOT_ALLOWED');
  }
}

export function tenantCapabilityViewRouteKey(path) {
  return path === CAPABILITIES_PATH ? 'tenant_capabilities' : null;
}

export function createTenantCapabilityViewHttpHandler({
  tenantCapabilityViewService,
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

  return async function handleTenantCapabilityView({
    request,
    response,
    parsedUrl,
    path,
    requestId,
  }) {
    if (!tenantCapabilityViewRouteKey(path)) return null;
    if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
    await assertEmptyBody(request);
    if (!tenantCapabilityViewService) throw new ApiError(503, 'TENANT_CAPABILITY_VIEW_UNAVAILABLE');
    const principal = await principalGuard.require(request);
    const tenantContext = await tenantGuard.requireKnown(principal);
    const view = await tenantCapabilityViewService.getView({
      principal,
      tenantContext,
      correlationId: requestId,
    });
    sendJson(response, 200, { ...view, requestId }, maxResponseBytes);
    return 200;
  };
}

export const tenantCapabilityViewRouteModule = defineRouteModule({
  id: 'tenant-capability-view',
  routeKey: tenantCapabilityViewRouteKey,
  createHandler: createTenantCapabilityViewHttpHandler,
});
