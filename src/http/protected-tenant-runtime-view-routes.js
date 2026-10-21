import { ApiError } from '../api-error.js';
import { requireProtectedTenantRuntime } from '../tenancy/protected-tenant-runtime.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { defineRouteModule } from './route-module.js';

const PATH='/api/v1/tenant/runtime';
// Nonsecret presentation metadata comes from the current compiled server scope.
// It grants no capability and never accepts a caller-selected mode/provider.
export function createProtectedTenantRuntimeViewRouteModule({ runtimeRepository,environment,securityEpoch }={}) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)
    || typeof runtimeRepository?.withCurrentTenantRuntime!=='function') {
    throw new TypeError('PROTECTED_RUNTIME_VIEW_CONFIGURATION_INVALID');
  }
  return defineRouteModule({ id: 'protected-tenant-runtime-view',routeKey: path=>path===PATH ? 'protected_tenant_runtime_view' : null,
    createHandler({ principalGuard,tenantGuard,maxResponseBytes }={}) {
      if (typeof principalGuard?.require!=='function' || typeof tenantGuard?.requireKnown!=='function'
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('PROTECTED_RUNTIME_VIEW_CONFIGURATION_INVALID');
      }
      return async ({ request,response,path,parsedUrl,requestId })=>{
        if (path!==PATH) return null;
        if (request.method!=='GET') throw new ApiError(405,'METHOD_NOT_ALLOWED');
        if (parsedUrl.search || parsedUrl.hash) throw new ApiError(400,'VALIDATION_FAILED');
        if (request.headers['transfer-encoding']!==undefined
          || request.headers['content-length']!==undefined && request.headers['content-length']!=='0') {
          throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
        }
        for await (const chunk of request) if (chunk.length) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
        const principal=await principalGuard.require(request),tenant=await tenantGuard.requireKnown(principal);
        if (principal.tenantId!==tenant.tenantId) throw new ApiError(403,'AUTHORIZATION_DENIED');
        const scope={ environment,securityEpoch,tenantId: tenant.tenantId };let invoked=false;
        const value=await runtimeRepository.withCurrentTenantRuntime(scope,descriptor=>{
          if (invoked) throw new ApiError(503,'PROTECTED_RUNTIME_VIEW_UNAVAILABLE');invoked=true;
          const runtime=requireProtectedTenantRuntime(scope,descriptor);
          return { mode: runtime.mode,provider: runtime.mode==='synthetic' ? 'synthetic_calendar' : 'microsoft365' };
        });
        if (!invoked) throw new ApiError(503,'PROTECTED_RUNTIME_VIEW_UNAVAILABLE');
        const body=JSON.stringify({ ...value,requestId });if (Buffer.byteLength(body)>maxResponseBytes) {
          throw new ApiError(500,'RESPONSE_TOO_LARGE');
        }
        response.statusCode=200;response.setHeader('Content-Type','application/json; charset=utf-8');
        response.setHeader('Cache-Control','private, no-store');response.setHeader('Content-Length',Buffer.byteLength(body));
        response.end(body);return 200;
      };
    },
  });
}
