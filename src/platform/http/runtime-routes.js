import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
} from './security.js';

export const PLATFORM_RUNTIME_DEPLOYMENTS_PATH = '/api/v1/platform/runtime/deployments';
const TENANT_RUNTIME_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/runtime$/i;

function tenantIdFor(path) {
  const match = path.match(TENANT_RUNTIME_PATH);
  return match && isInternalUuid(match[1]) ? match[1].toLowerCase() : null;
}

export const platformRuntimeRoutes = definePlatformRouteModule({
  id: 'platform-runtime',
  claim({ path }) {
    if (path === PLATFORM_RUNTIME_DEPLOYMENTS_PATH) return PLATFORM_HTTP_ROUTE.RUNTIME_DEPLOYMENTS;
    return tenantIdFor(path) === null ? null : PLATFORM_HTTP_ROUTE.TENANT_RUNTIME;
  },
  createHandler({ platformRuntimeStatusService, platformPrincipalGuard, maxResponseBytes }) {
    if (
      !platformRuntimeStatusService
      || typeof platformRuntimeStatusService.listApprovedDeployments !== 'function'
      || typeof platformRuntimeStatusService.getServingDeploymentForTenant !== 'function'
    ) throw new TypeError('PLATFORM_RUNTIME_STATUS_SERVICE_REQUIRED');
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      const tenantId = tenantIdFor(path);
      if (path !== PLATFORM_RUNTIME_DEPLOYMENTS_PATH && tenantId === null) return null;
      if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      assertPlatformNoQuery(parsedUrl);
      const operatorContext = await platformPrincipalGuard.require(request, { correlationId: requestId });
      await assertNoPlatformRequestBody(request);
      const result = path === PLATFORM_RUNTIME_DEPLOYMENTS_PATH
        ? await platformRuntimeStatusService.listApprovedDeployments({ operatorContext })
        : await platformRuntimeStatusService.getServingDeploymentForTenant({ operatorContext, tenantId });
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
