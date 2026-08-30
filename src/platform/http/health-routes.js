import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
} from './security.js';

export const PLATFORM_HEALTH_PATH = Object.freeze({
  LIVE: '/api/v1/platform/health/live',
  READY: '/api/v1/platform/health/ready',
  STATUS: '/api/v1/platform/health/status',
});

export const platformHealthRoutes = definePlatformRouteModule({
  id: 'platform-health',
  claim({ path }) {
    if (path === PLATFORM_HEALTH_PATH.LIVE) return PLATFORM_HTTP_ROUTE.HEALTH_LIVE;
    if (path === PLATFORM_HEALTH_PATH.READY) return PLATFORM_HTTP_ROUTE.HEALTH_READY;
    if (path === PLATFORM_HEALTH_PATH.STATUS) return PLATFORM_HTTP_ROUTE.HEALTH_STATUS;
    return null;
  },
  createHandler({ platformHealthMonitor, platformRuntimeMetadata, maxResponseBytes }) {
    if (!platformHealthMonitor || typeof platformHealthMonitor.evaluate !== 'function') {
      throw new TypeError('PLATFORM_HEALTH_MONITOR_REQUIRED');
    }
    if (
      !platformRuntimeMetadata
      || typeof platformRuntimeMetadata !== 'object'
      || Array.isArray(platformRuntimeMetadata)
      || typeof platformRuntimeMetadata.serviceVersion !== 'string'
      || typeof platformRuntimeMetadata.buildId !== 'string'
      || typeof platformRuntimeMetadata.environment !== 'string'
    ) throw new TypeError('PLATFORM_RUNTIME_METADATA_REQUIRED');

    return async function handle({ path, parsedUrl, request, response }) {
      if (!Object.values(PLATFORM_HEALTH_PATH).includes(path)) return null;
      if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      assertPlatformNoQuery(parsedUrl);
      await assertNoPlatformRequestBody(request);
      if (path === PLATFORM_HEALTH_PATH.LIVE) {
        sendPlatformJson(response, 200, Object.freeze({ status: 'live' }), maxResponseBytes);
        return 200;
      }
      const health = await platformHealthMonitor.evaluate();
      if (
        !health
        || typeof health !== 'object'
        || Array.isArray(health)
        || !['ready', 'degraded', 'not_ready'].includes(health.status)
        || typeof health.ready !== 'boolean'
        || typeof health.degraded !== 'boolean'
      ) throw new PlatformHttpError(500, 'PLATFORM_HEALTH_RESULT_INVALID');
      const statusCode = health.ready ? 200 : 503;
      const payload = path === PLATFORM_HEALTH_PATH.READY
        ? Object.freeze({ status: health.ready ? 'ready' : 'not_ready' })
        : Object.freeze({
          status: health.status,
          serviceVersion: platformRuntimeMetadata.serviceVersion,
          buildId: platformRuntimeMetadata.buildId,
          environment: platformRuntimeMetadata.environment,
        });
      sendPlatformJson(response, statusCode, payload, maxResponseBytes);
      return statusCode;
    };
  },
});
