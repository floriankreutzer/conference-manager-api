import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { isPlatformCanonicalInstant } from './privileged-operation.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
} from './security.js';

const DIAGNOSTIC_SUMMARY_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/diagnostics$/i;
const DIAGNOSTIC_CORRELATION_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/diagnostics\/correlations\/([0-9a-f-]{36})$/i;

function invalid() {
  throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
}

function matched(path) {
  const correlation = path.match(DIAGNOSTIC_CORRELATION_PATH);
  if (correlation && isInternalUuid(correlation[1]) && isInternalUuid(correlation[2])) {
    return Object.freeze({
      type: 'correlation',
      tenantId: correlation[1].toLowerCase(),
      lookupCorrelationId: correlation[2].toLowerCase(),
    });
  }
  const summary = path.match(DIAGNOSTIC_SUMMARY_PATH);
  if (summary && isInternalUuid(summary[1])) {
    return Object.freeze({ type: 'summary', tenantId: summary[1].toLowerCase() });
  }
  return null;
}

function correlationQuery(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!['from', 'to', 'limit'].includes(key) || parsedUrl.searchParams.getAll(key).length !== 1) invalid();
  }
  const from = parsedUrl.searchParams.get('from');
  const to = parsedUrl.searchParams.get('to');
  const limit = parsedUrl.searchParams.get('limit');
  if (!isPlatformCanonicalInstant(from) || !isPlatformCanonicalInstant(to)) invalid();
  if (limit !== null && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100)) invalid();
  return Object.freeze({ from, to, limit: limit === null ? 50 : Number(limit) });
}

export const platformDiagnosticRoutes = definePlatformRouteModule({
  id: 'platform-diagnostics',
  claim({ path }) {
    const match = matched(path);
    if (match?.type === 'summary') return PLATFORM_HTTP_ROUTE.DIAGNOSTIC_SUMMARY;
    if (match?.type === 'correlation') return PLATFORM_HTTP_ROUTE.DIAGNOSTIC_CORRELATION;
    return null;
  },
  createHandler({
    platformDiagnosticOperationsService,
    platformPrincipalGuard,
    maxResponseBytes,
  }) {
    const service = platformDiagnosticOperationsService;
    if (
      !service
      || typeof service.getTenantSummary !== 'function'
      || typeof service.lookupCorrelation !== 'function'
    ) throw new TypeError('PLATFORM_DIAGNOSTIC_OPERATIONS_SERVICE_REQUIRED');
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      const match = matched(path);
      if (match === null) return null;
      if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      const operatorContext = await platformPrincipalGuard.require(request, {
        correlationId: requestId,
      });
      await assertNoPlatformRequestBody(request);
      let result;
      if (match.type === 'summary') {
        assertPlatformNoQuery(parsedUrl);
        result = await service.getTenantSummary({
          operatorContext,
          tenantId: match.tenantId,
          correlationId: requestId,
        });
      } else {
        result = await service.lookupCorrelation({
          operatorContext,
          tenantId: match.tenantId,
          lookupCorrelationId: match.lookupCorrelationId,
          correlationId: requestId,
          ...correlationQuery(parsedUrl),
        });
      }
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
