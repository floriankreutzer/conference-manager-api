import { ApiError } from '../../api-error.js';
import { defineRouteModule } from '../route-module.js';

export const TENANT_PRESENTATION_PATH = '/api/v1/tenant/presentation';

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

export function tenantPresentationRouteKey(path) {
  return path === TENANT_PRESENTATION_PATH ? 'tenant_presentation' : null;
}

export function createTenantPresentationHttpHandler({
  tenantPresentationService,
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

  return async function handleTenantPresentation({
    request,
    response,
    parsedUrl,
    path,
    requestId,
  }) {
    if (!tenantPresentationRouteKey(path)) return null;
    if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    if ([...parsedUrl.searchParams.keys()].length > 0) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
    await assertEmptyBody(request);
    if (!tenantPresentationService) throw new ApiError(503, 'TENANT_PRESENTATION_UNAVAILABLE');
    const principal = await principalGuard.require(request);
    const tenantContext = await tenantGuard.requireKnown(principal);
    const view = await tenantPresentationService.current({
      principal,
      tenantContext,
      correlationId: requestId,
    });
    sendJson(response, 200, view, maxResponseBytes);
    return 200;
  };
}

export const tenantPresentationRouteModule = defineRouteModule({
  id: 'tenant-presentation',
  routeKey: tenantPresentationRouteKey,
  createHandler: createTenantPresentationHttpHandler,
});
