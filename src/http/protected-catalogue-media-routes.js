import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { MediaObjectStorageError } from '../media/object-storage-contract.js';
import { defineRouteModule } from './route-module.js';
import { sendPrivateMediaResponse } from './private-media-response.js';

const ROOT='/api/v1/tenant/catalogue-media';
function selection(path) {
  if (path===ROOT) return { assetId: null };
  const assetId=path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length+1) : null;
  return isInternalUuid(assetId) ? { assetId } : null;
}
export function createProtectedCatalogueMediaRouteModule({ service }={}) {
  if (typeof service?.list!=='function' || typeof service?.find!=='function') {
    throw new TypeError('PROTECTED_CATALOGUE_MEDIA_HTTP_CONFIGURATION_INVALID');
  }
  return defineRouteModule({ id: 'protected-catalogue-media',routeKey: path=>selection(path) ? 'protected_catalogue_media' : null,
    createHandler({ principalGuard,tenantGuard,maxResponseBytes }={}) {
      if (typeof principalGuard?.require!=='function' || typeof tenantGuard?.requireKnown!=='function'
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('PROTECTED_CATALOGUE_MEDIA_HTTP_CONFIGURATION_INVALID');
      }
      return async ({ request,response,path,parsedUrl,requestId })=>{
        const selected=selection(path);if (!selected) return null;
        if (request.method!=='GET') throw new ApiError(405,'METHOD_NOT_ALLOWED');
        if (parsedUrl.search || parsedUrl.hash) throw new ApiError(400,'VALIDATION_FAILED');
        if (request.headers['sec-fetch-site']!==undefined && request.headers['sec-fetch-site']!=='same-origin') {
          throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        }
        if (request.headers['transfer-encoding']!==undefined
          || request.headers['content-length']!==undefined && request.headers['content-length']!=='0') {
          throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
        }
        for await (const chunk of request) if (chunk.length) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
        const principal=await principalGuard.require(request),tenantContext=await tenantGuard.requireKnown(principal);
        try {
          if (selected.assetId!==null) {
            const asset=await service.find({ principal,tenantContext },selected.assetId);
            if (!asset) throw new ApiError(404,'NOT_FOUND');
            return sendPrivateMediaResponse({ request,response,tenantId: tenantContext.tenantId,assetId: selected.assetId,
              contentType: asset.contentType,bytes: asset.bytes });
          }
          const body=JSON.stringify({ assets: await service.list({ principal,tenantContext }),requestId });
          if (Buffer.byteLength(body)>maxResponseBytes) throw new ApiError(500,'RESPONSE_TOO_LARGE');
          response.statusCode=200;response.setHeader('Content-Type','application/json; charset=utf-8');
          response.setHeader('Cache-Control','private, no-store');response.setHeader('Content-Length',Buffer.byteLength(body));
          response.end(body);return 200;
        } catch (error) {
          if (error instanceof MediaObjectStorageError) throw new ApiError(503,'CATALOGUE_MEDIA_UNAVAILABLE');
          throw error;
        }
      };
    },
  });
}
