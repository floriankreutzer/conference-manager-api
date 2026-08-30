import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { isPlatformSafeCode } from './privileged-operation.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import { assertNoPlatformRequestBody } from './security.js';

export const PLATFORM_MICROSOFT_HEALTH_PATH = '/api/v1/platform/microsoft365/health';

const LIFECYCLE_STATUSES = new Set([
  'pending',
  'onboarding',
  'ready',
  'active',
  'suspended',
  'archived',
]);
const CURSOR = /^[A-Za-z0-9_.-]{1,4096}$/;

function invalid() {
  throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
}

function healthQuery(parsedUrl) {
  const allowed = new Set([
    'limit',
    'cursor',
    'lifecycleStatus',
    'capability',
    'healthStatus',
    'incidentScope',
  ]);
  for (const key of parsedUrl.searchParams.keys()) {
    if (!allowed.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) invalid();
  }
  const result = {};
  const limit = parsedUrl.searchParams.get('limit');
  if (limit !== null) {
    if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) invalid();
    result.limit = Number(limit);
  }
  const cursor = parsedUrl.searchParams.get('cursor');
  if (cursor !== null) {
    if (!CURSOR.test(cursor)) invalid();
    result.cursor = cursor;
  }
  const lifecycleStatus = parsedUrl.searchParams.get('lifecycleStatus');
  if (lifecycleStatus !== null) {
    if (!LIFECYCLE_STATUSES.has(lifecycleStatus)) invalid();
    result.lifecycleStatus = lifecycleStatus;
  }
  for (const key of ['capability', 'healthStatus', 'incidentScope']) {
    const value = parsedUrl.searchParams.get(key);
    if (value !== null) {
      if (!isPlatformSafeCode(value)) invalid();
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

export const platformMicrosoftHealthRoutes = definePlatformRouteModule({
  id: 'platform-microsoft-health',
  claim({ path }) {
    return path === PLATFORM_MICROSOFT_HEALTH_PATH
      ? PLATFORM_HTTP_ROUTE.MICROSOFT_HEALTH
      : null;
  },
  createHandler({
    platformMicrosoftFleetHealthService,
    platformPrincipalGuard,
    maxResponseBytes,
  }) {
    if (
      !platformMicrosoftFleetHealthService
      || typeof platformMicrosoftFleetHealthService.listFleetHealth !== 'function'
    ) throw new TypeError('PLATFORM_MICROSOFT_FLEET_HEALTH_SERVICE_REQUIRED');
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      if (path !== PLATFORM_MICROSOFT_HEALTH_PATH) return null;
      if (request.method !== 'GET') {
        throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      }
      const operatorContext = await platformPrincipalGuard.require(request, {
        correlationId: requestId,
      });
      await assertNoPlatformRequestBody(request);
      const result = await platformMicrosoftFleetHealthService.listFleetHealth({
        operatorContext,
        query: healthQuery(parsedUrl),
      });
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
