import { ApiError } from '../../api-error.js';
import { readJsonObjectBody } from '../../security.js';
import { defineRouteModule } from '../route-module.js';

const ORGANIZATION_PATH = '/api/v1/tenant/organization';
const ASSETS_PATH = '/api/v1/tenant/organization/logo-assets';
const ASSET_PATH = /^\/api\/v1\/tenant\/organization\/logo-assets\/([0-9a-f-]{36})$/i;

function routeKey(path) {
  if (path === ORGANIZATION_PATH) return 'tenant_organization';
  if (path === ASSETS_PATH) return 'tenant_organization_logo_assets';
  if (ASSET_PATH.test(path)) return 'tenant_organization_logo_asset';
  return null;
}

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
}

function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

export function createTenantOrganizationRouteModule({ service } = {}) {
  if (
    !service
    || typeof service.get !== 'function'
    || typeof service.update !== 'function'
    || typeof service.uploadBrandAsset !== 'function'
    || typeof service.getBrandAsset !== 'function'
  ) throw new TypeError('TENANT_ORGANIZATION_SERVICE_REQUIRED');

  return defineRouteModule({
    id: 'tenant-organization',
    routeKey,
    createHandler({ principalGuard, tenantGuard, maxBodyBytes, maxResponseBytes } = {}) {
      if (!principalGuard || !tenantGuard) throw new TypeError('TENANT_ORGANIZATION_HTTP_GUARDS_REQUIRED');
      return async function handle({ request, response, parsedUrl, path, requestId }) {
        if (routeKey(path) === null) return null;
        assertNoQuery(parsedUrl);
        const assetMatch = path.match(ASSET_PATH);
        const mutation = request.method === 'PUT' || request.method === 'POST';
        const principal = await principalGuard.require(request, { csrf: mutation });
        const tenantContext = await tenantGuard.requireKnown(principal);

        if (path === ORGANIZATION_PATH) {
          if (request.method !== 'GET' && request.method !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
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
        }

        if (path === ASSETS_PATH) {
          if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          const result = await service.uploadBrandAsset({
            principal,
            tenantContext,
            correlationId: requestId,
            payload: await readJsonObjectBody(request, { maxBytes: Math.min(maxBodyBytes, 700_000) }),
          });
          sendJson(response, 201, { schemaVersion: 1, asset: result }, maxResponseBytes);
          return 201;
        }

        if (assetMatch) {
          if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
          const asset = await service.getBrandAsset({
            principal,
            tenantContext,
            correlationId: requestId,
            assetId: assetMatch[1].toLowerCase(),
          });
          if (asset.content.length > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
          response.statusCode = 200;
          response.setHeader('Content-Type', asset.mediaType);
          response.setHeader('Content-Length', asset.content.length);
          response.setHeader('ETag', `"sha256-${asset.sha256}"`);
          response.end(asset.content);
          return 200;
        }

        return null;
      };
    },
  });
}
