import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import { assertNoPlatformRequestBody } from './security.js';

export const PLATFORM_AUDIT_EVENTS_PATH = '/api/v1/platform/audit/events';
export const PLATFORM_AUDIT_EXPORTS_PATH = '/api/v1/platform/audit/exports';

function invalid() {
  throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
}

function auditQuery(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!['limit', 'beforeSequence'].includes(key) || parsedUrl.searchParams.getAll(key).length !== 1) invalid();
  }
  const limit = parsedUrl.searchParams.get('limit');
  const beforeSequence = parsedUrl.searchParams.get('beforeSequence');
  if (limit !== null && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100)) invalid();
  if (beforeSequence !== null && (!/^[2-9]\d*$/.test(beforeSequence) || !Number.isSafeInteger(Number(beforeSequence)))) {
    invalid();
  }
  return Object.freeze({
    limit: limit === null ? 50 : Number(limit),
    beforeSequence: beforeSequence === null ? null : Number(beforeSequence),
  });
}

export const platformAuditRoutes = definePlatformRouteModule({
  id: 'platform-audit',
  claim({ path }) {
    if (path === PLATFORM_AUDIT_EVENTS_PATH) return PLATFORM_HTTP_ROUTE.AUDIT_EVENTS;
    if (path === PLATFORM_AUDIT_EXPORTS_PATH) return PLATFORM_HTTP_ROUTE.AUDIT_EXPORTS;
    return null;
  },
  createHandler({ platformAuditService, platformPrincipalGuard, maxResponseBytes }) {
    if (
      !platformAuditService
      || typeof platformAuditService.list !== 'function'
      || typeof platformAuditService.export !== 'function'
    ) throw new TypeError('PLATFORM_AUDIT_QUERY_SERVICE_REQUIRED');
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      if (path !== PLATFORM_AUDIT_EVENTS_PATH && path !== PLATFORM_AUDIT_EXPORTS_PATH) return null;
      if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      const principal = await platformPrincipalGuard.require(request, { correlationId: requestId });
      await assertNoPlatformRequestBody(request);
      const input = {
        principal,
        ...auditQuery(parsedUrl),
        correlationId: requestId,
      };
      const items = path === PLATFORM_AUDIT_EVENTS_PATH
        ? await platformAuditService.list(input)
        : await platformAuditService.export(input);
      if (!Array.isArray(items) || items.length > 100) {
        throw new PlatformHttpError(500, 'PLATFORM_AUDIT_RESULT_INVALID');
      }
      sendPlatformJson(response, 200, Object.freeze({ schemaVersion: 1, items }), maxResponseBytes);
      return 200;
    };
  },
});
