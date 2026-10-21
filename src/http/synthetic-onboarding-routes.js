import { ApiError } from '../api-error.js';
import { SyntheticOnboardingError } from '../domain/synthetic-onboarding.js';
import { readJsonObjectBody } from '../security.js';
import { defineRouteModule } from './route-module.js';

const ROOT='/api/v1/integrations/synthetic-calendar';
const ROUTES=new Map([[ROOT,'view'],[`${ROOT}/rooms/import`,'importRooms'],[`${ROOT}/lifecycle/transitions`,'transition']]);
async function empty(request) {
  if (request.headers['transfer-encoding']!==undefined
    || request.headers['content-length']!==undefined && request.headers['content-length']!=='0') {
    throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
}
export function createSyntheticOnboardingRouteModule({ service,publicOrigin }={}) {
  let origin;try { origin=new URL(publicOrigin); } catch { throw new TypeError('SYNTHETIC_ONBOARDING_HTTP_CONFIGURATION_INVALID'); }
  if (origin.protocol!=='https:' || origin.origin!==publicOrigin
    || ['view','importRooms','transition'].some(name=>typeof service?.[name]!=='function')) {
    throw new TypeError('SYNTHETIC_ONBOARDING_HTTP_CONFIGURATION_INVALID');
  }
  return defineRouteModule({ id: 'synthetic-onboarding',routeKey: path=>ROUTES.has(path) ? 'synthetic_onboarding' : null,
    createHandler({ principalGuard,tenantGuard,maxBodyBytes,maxResponseBytes }={}) {
      if (typeof principalGuard?.require!=='function' || typeof tenantGuard?.requireKnown!=='function'
        || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('SYNTHETIC_ONBOARDING_HTTP_CONFIGURATION_INVALID');
      }
      return async ({ request,response,path,parsedUrl,requestId })=>{
        const operation=ROUTES.get(path);if (!operation) return null;const read=operation==='view';
        if (request.method!==(read ? 'GET' : 'POST')) throw new ApiError(405,'METHOD_NOT_ALLOWED');
        if (parsedUrl.search || parsedUrl.hash) throw new ApiError(400,'VALIDATION_FAILED');
        if (request.headers['sec-fetch-site']!==undefined && request.headers['sec-fetch-site']!=='same-origin'
          || !read && request.headers.origin!==publicOrigin) throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        const principal=await principalGuard.require(request,{ csrf: !read });
        const tenantContext=await tenantGuard.requireKnown(principal),context={ principal,tenantContext,correlationId: requestId };
        let result;
        try {
          if (read) { await empty(request);result=await service.view(context); }
          else result=await service[operation](context,await readJsonObjectBody(request,{ maxBytes: Math.min(maxBodyBytes,4096) }));
        } catch (error) {
          if (!(error instanceof SyntheticOnboardingError)) throw error;
          const codes={ SYNTHETIC_ONBOARDING_INPUT_INVALID: 400,SYNTHETIC_ONBOARDING_CONFLICT: 409,
            SYNTHETIC_ONBOARDING_AUTHORITY_DENIED: 403,SYNTHETIC_ONBOARDING_STATE_INVALID: 503 };
          throw new ApiError(codes[error.code] ?? 503,error.code);
        }
        const body=JSON.stringify({ ...result,requestId });if (Buffer.byteLength(body)>maxResponseBytes) {
          throw new ApiError(500,'RESPONSE_TOO_LARGE');
        }
        response.statusCode=200;response.setHeader('Content-Type','application/json; charset=utf-8');
        response.setHeader('Cache-Control','private, no-store');response.setHeader('Content-Length',Buffer.byteLength(body));
        response.end(body);return 200;
      };
    },
  });
}
