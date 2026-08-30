import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { isPlatformSafeCode } from './privileged-operation.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import { assertNoPlatformRequestBody } from './security.js';

export const PLATFORM_READINESS_PATH = '/api/v1/platform/readiness';

const LIFECYCLE_STATUSES = new Set([
  'pending',
  'onboarding',
  'ready',
  'active',
  'suspended',
  'archived',
]);
const READINESS_STATES = new Set(['ready', 'blocked', 'stale', 'unknown']);
const CURSOR = /^[A-Za-z0-9_.-]{1,4096}$/;

function invalid() {
  throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
}

function readinessQuery(parsedUrl) {
  const allowed = new Set([
    'limit',
    'cursor',
    'lifecycleStatus',
    'readinessState',
    'blockerCode',
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
  const readinessState = parsedUrl.searchParams.get('readinessState');
  if (readinessState !== null) {
    if (!READINESS_STATES.has(readinessState)) invalid();
    result.readinessState = readinessState;
  }
  const blockerCode = parsedUrl.searchParams.get('blockerCode');
  if (blockerCode !== null) {
    if (!isPlatformSafeCode(blockerCode)) invalid();
    result.blockerCode = blockerCode;
  }
  return Object.freeze(result);
}

export const platformReadinessRoutes = definePlatformRouteModule({
  id: 'platform-readiness',
  claim({ path }) {
    return path === PLATFORM_READINESS_PATH ? PLATFORM_HTTP_ROUTE.READINESS : null;
  },
  createHandler({ platformFleetReadinessService, platformPrincipalGuard, maxResponseBytes }) {
    if (
      !platformFleetReadinessService
      || typeof platformFleetReadinessService.listFleetReadiness !== 'function'
    ) throw new TypeError('PLATFORM_FLEET_READINESS_SERVICE_REQUIRED');
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      if (path !== PLATFORM_READINESS_PATH) return null;
      if (request.method !== 'GET') {
        throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      }
      const operatorContext = await platformPrincipalGuard.require(request, {
        correlationId: requestId,
      });
      await assertNoPlatformRequestBody(request);
      const result = await platformFleetReadinessService.listFleetReadiness({
        operatorContext,
        query: readinessQuery(parsedUrl),
      });
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
