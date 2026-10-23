import { definePlatformRouteModule } from './route-module.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { PlatformHttpError } from './errors.js';
import { assertNoPlatformRequestBody, assertPlatformNoQuery } from './security.js';
import { sendPlatformJson } from './response.js';

const PATHS = new Map([
  ['/api/v1/platform/insights/providers', { kind: 'providers', route: PLATFORM_HTTP_ROUTE.INSIGHT_PROVIDERS }],
  ['/api/v1/platform/insights/product-delivery', { kind: 'product-delivery', route: PLATFORM_HTTP_ROUTE.INSIGHT_PRODUCT }],
]);

// Registered only by the owned active protected Platform composition.
export function createPlatformInsightRoutes(service) {
  if (typeof service?.read !== 'function') throw new TypeError('PLATFORM_INSIGHT_SERVICE_REQUIRED');
  return definePlatformRouteModule({ id: 'platform-insights', claim: ({ path }) => PATHS.get(path)?.route ?? null,
    createHandler({ platformPrincipalGuard, maxResponseBytes }) {
      if (typeof platformPrincipalGuard?.require !== 'function') throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
      return async ({ path, parsedUrl, request, response, requestId }) => {
        const entry = PATHS.get(path); if (!entry) return null;
        if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
        assertPlatformNoQuery(parsedUrl);
        const operatorContext = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        const report = service.read({ operatorContext, kind: entry.kind });
        if (report === null) throw new PlatformHttpError(503, 'PLATFORM_INSIGHT_SOURCE_UNAVAILABLE');
        sendPlatformJson(response, 200, report, maxResponseBytes); return 200;
      };
    },
  });
}
