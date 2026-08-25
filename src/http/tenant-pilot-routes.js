import { ApiError } from '../api-error.js';

export const TENANT_PILOT_ROUTE = '/api/v1/tenant/pilot-readiness';

function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify({ schemaVersion: 1, ...payload });
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

export function tenantPilotRouteKey(path) {
  return path === TENANT_PILOT_ROUTE ? 'tenant_pilot_readiness' : null;
}

export function createTenantPilotHttpHandler({ service, principalGuard, tenantGuard, maxResponseBytes } = {}) {
  if (!principalGuard || typeof principalGuard.require !== 'function') {
    throw new TypeError('PRINCIPAL_GUARD_REQUIRED');
  }
  if (!tenantGuard || typeof tenantGuard.requireKnown !== 'function') {
    throw new TypeError('TENANT_GUARD_REQUIRED');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
    throw new TypeError('MAX_RESPONSE_BYTES_INVALID');
  }

  return async function handleTenantPilot({ request, response, parsedUrl, path }) {
    if (path !== TENANT_PILOT_ROUTE) return null;
    if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
    if (!service || typeof service.getReadiness !== 'function') {
      throw new ApiError(503, 'TENANT_PILOT_SERVICE_UNAVAILABLE');
    }
    const principal = await principalGuard.require(request);
    const tenantContext = await tenantGuard.requireKnown(principal);
    const readiness = await service.getReadiness({ principal, tenantContext });
    if (!readiness) throw new ApiError(404, 'NOT_FOUND');
    sendJson(response, 200, { readiness }, maxResponseBytes);
    return 200;
  };
}
