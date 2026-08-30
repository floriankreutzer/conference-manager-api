import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import {
  isPlatformBoundedText,
  isPlatformCanonicalInstant,
  isPlatformNonnegativeRevision,
  platformMutationAuthority,
} from './privileged-operation.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import {
  assertNoPlatformRequestBody,
  readPlatformJsonObject,
  requirePlatformExactObject,
} from './security.js';

const METERING_USAGE_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/metering\/usage$/i;
const QUOTA_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/quotas\/([a-z_]{1,32})$/i;
const QUOTA_CONFIRMATION_ACTION = 'tenant.quota.set';
const DIMENSIONS = new Set([
  'active_users',
  'active_rooms',
  'requests_created',
  'bookings_confirmed',
  'integration_operations',
]);
const QUOTA_STATES = new Set(['configured', 'not_configured']);

function invalid() {
  throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
}

function matched(path) {
  const quota = path.match(QUOTA_PATH);
  if (quota && isInternalUuid(quota[1]) && DIMENSIONS.has(quota[2])) {
    return Object.freeze({
      type: 'quota',
      tenantId: quota[1].toLowerCase(),
      dimension: quota[2],
    });
  }
  const usage = path.match(METERING_USAGE_PATH);
  if (usage && isInternalUuid(usage[1])) {
    return Object.freeze({ type: 'usage', tenantId: usage[1].toLowerCase() });
  }
  return null;
}

function periodQuery(parsedUrl) {
  const keys = [...parsedUrl.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'periodStart' || parsedUrl.searchParams.getAll('periodStart').length !== 1) {
    invalid();
  }
  const periodStart = parsedUrl.searchParams.get('periodStart');
  if (!isPlatformCanonicalInstant(periodStart)) invalid();
  const instant = new Date(periodStart);
  if (
    instant.getUTCDate() !== 1
    || instant.getUTCHours() !== 0
    || instant.getUTCMinutes() !== 0
    || instant.getUTCSeconds() !== 0
    || instant.getUTCMilliseconds() !== 0
  ) invalid();
  return periodStart;
}

function optionalQuotaLimit(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function quotaBody(value, tenantId, dimension) {
  const body = requirePlatformExactObject(value, {
    required: {
      state: (candidate) => QUOTA_STATES.has(candidate),
      softLimit: optionalQuotaLimit,
      hardLimit: optionalQuotaLimit,
      expectedRevision: isPlatformNonnegativeRevision,
      reason: (candidate) => isPlatformBoundedText(candidate, 500),
      confirmation: (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate),
    },
  });
  requirePlatformExactObject(body.confirmation, {
    required: {
      action: (candidate) => candidate === QUOTA_CONFIRMATION_ACTION,
      tenantId: (candidate) => isInternalUuid(candidate) && candidate.toLowerCase() === tenantId,
      dimension: (candidate) => candidate === dimension,
    },
  });
  return Object.freeze({
    state: body.state,
    softLimit: body.softLimit,
    hardLimit: body.hardLimit,
    expectedRevision: body.expectedRevision,
    reason: body.reason,
    confirmation: Object.freeze({ action: QUOTA_CONFIRMATION_ACTION, tenantId, dimension }),
  });
}

export const platformMeteringRoutes = definePlatformRouteModule({
  id: 'platform-metering',
  claim({ path }) {
    const match = matched(path);
    if (match?.type === 'usage') return PLATFORM_HTTP_ROUTE.METERING_USAGE;
    if (match?.type === 'quota') return PLATFORM_HTTP_ROUTE.QUOTA_SET;
    return null;
  },
  createHandler({ platformMeteringService, platformPrincipalGuard, maxBodyBytes, maxResponseBytes }) {
    if (
      !platformMeteringService
      || typeof platformMeteringService.getUsagePeriod !== 'function'
      || typeof platformMeteringService.setOperationalQuota !== 'function'
    ) throw new TypeError('PLATFORM_METERING_SERVICE_REQUIRED');
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      const match = matched(path);
      if (match === null) return null;
      if (match.type === 'usage') {
        if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
        const operatorContext = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        const result = await platformMeteringService.getUsagePeriod({
          operatorContext,
          tenantId: match.tenantId,
          periodStart: periodQuery(parsedUrl),
        });
        sendPlatformJson(response, 200, result, maxResponseBytes);
        return 200;
      }

      if (request.method !== 'POST') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      if ([...parsedUrl.searchParams.keys()].length > 0) invalid();
      const authority = await platformMutationAuthority({
        platformPrincipalGuard,
        request,
        correlationId: requestId,
      });
      const body = quotaBody(
        await readPlatformJsonObject(request, { maxBytes: maxBodyBytes }),
        match.tenantId,
        match.dimension,
      );
      const result = await platformMeteringService.setOperationalQuota({
        ...authority,
        tenantId: match.tenantId,
        dimension: match.dimension,
        ...body,
        correlationId: requestId,
      });
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
