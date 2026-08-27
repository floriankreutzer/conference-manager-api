import { ApiError } from '../../api-error.js';
import { readJsonObjectBody } from '../../security.js';
import { defineRouteModule } from '../route-module.js';

const PATH = '/api/v1/tenant/catalog';
function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}
export function createTenantCatalogRouteModule({ service } = {}) {
  if (!service || typeof service.get !== 'function' || typeof service.update !== 'function') throw new TypeError('TENANT_CATALOG_SERVICE_REQUIRED');
  return defineRouteModule({
    id: 'tenant-catalog',
    routeKey: (path) => path === PATH ? 'tenant_catalog' : null,
    createHandler({ principalGuard, tenantGuard, maxBodyBytes, maxResponseBytes } = {}) {
      return async function handle({ request, response, parsedUrl, path, requestId }) {
        if (path !== PATH) return null;
        if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
        if (request.method !== 'GET' && request.method !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        const principal = await principalGuard.require(request, { csrf: request.method === 'PUT' });
        const tenantContext = await tenantGuard.requireKnown(principal);
        const result = request.method === 'GET'
          ? await service.get({ principal, tenantContext, correlationId: requestId })
          : await service.update({
            principal,
            tenantContext,
            correlationId: requestId,
            payload: await readJsonObjectBody(request, { maxBytes: maxBodyBytes }),
          });
        sendJson(response, 200, result, maxResponseBytes);
        return 200;
      };
    },
  });
}
