import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_OPERATION } from '../application/platform-operation-contract.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import {
  isPlatformBoundedText,
  isPlatformPositiveRevision,
  isPlatformSafeCode,
  platformMutationAuthority,
  requirePlatformTenantConfirmation,
} from './privileged-operation.js';
import { definePlatformRouteModule } from './route-module.js';
import { sendPlatformJson } from './response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
  readPlatformJsonObject,
  requirePlatformExactObject,
} from './security.js';

export const PLATFORM_CAPABILITIES_PATH = '/api/v1/platform/capabilities';
export const PLATFORM_PACKAGES_PATH = '/api/v1/platform/packages';

const TENANT_ENTITLEMENTS_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/entitlements$/i;
const ENTITLEMENT_PREVIEW_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/entitlement-previews$/i;
const PACKAGE_PREVIEW_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/package-previews\/([a-z][a-z0-9_.-]{0,95})$/;
const ENTITLEMENT_APPLY_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/entitlement-applications$/i;
const PACKAGE_APPLY_PATH = /^\/api\/v1\/platform\/tenants\/([0-9a-f-]{36})\/package-applications\/([a-z][a-z0-9_.-]{0,95})$/i;
const CURSOR = /^[A-Za-z0-9_.-]{1,4096}$/;

function invalid() {
  throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
}

function packageQuery(parsedUrl) {
  const result = {};
  for (const key of parsedUrl.searchParams.keys()) {
    if (!['limit', 'cursor'].includes(key) || parsedUrl.searchParams.getAll(key).length !== 1) invalid();
  }
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
  return Object.freeze(result);
}

function proposals(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return false;
  const ids = new Set();
  for (const proposal of value) {
    if (
      !proposal
      || typeof proposal !== 'object'
      || Array.isArray(proposal)
      || Object.keys(proposal).sort().join(',') !== 'capabilityId,enabled'
      || !isPlatformSafeCode(proposal.capabilityId)
      || typeof proposal.enabled !== 'boolean'
      || ids.has(proposal.capabilityId)
    ) return false;
    ids.add(proposal.capabilityId);
  }
  return true;
}

function previewBody(value) {
  return requirePlatformExactObject(value, { required: { proposals } });
}

function entitlementApplyBody(value, tenantId) {
  const body = requirePlatformExactObject(value, {
    required: {
      proposals,
      expectedEntitlementRevision: isPlatformPositiveRevision,
      reason: (candidate) => isPlatformBoundedText(candidate, 500),
      confirmation: (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate),
    },
  });
  return Object.freeze({
    proposals: body.proposals,
    expectedEntitlementRevision: body.expectedEntitlementRevision,
    reason: body.reason,
    confirmation: requirePlatformTenantConfirmation(body.confirmation, {
      action: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
      tenantId,
    }),
  });
}

function packageApplyBody(value, tenantId) {
  const body = requirePlatformExactObject(value, {
    required: {
      expectedPackageRevision: isPlatformPositiveRevision,
      expectedEntitlementRevision: isPlatformPositiveRevision,
      reason: (candidate) => isPlatformBoundedText(candidate, 500),
      confirmation: (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate),
    },
  });
  return Object.freeze({
    expectedPackageRevision: body.expectedPackageRevision,
    expectedEntitlementRevision: body.expectedEntitlementRevision,
    reason: body.reason,
    confirmation: requirePlatformTenantConfirmation(body.confirmation, {
      action: PLATFORM_OPERATION.ENTITLEMENT_APPLY,
      tenantId,
    }),
  });
}

function matched(path) {
  for (const [type, pattern] of [
    ['entitlements', TENANT_ENTITLEMENTS_PATH],
    ['entitlement-preview', ENTITLEMENT_PREVIEW_PATH],
    ['package-preview', PACKAGE_PREVIEW_PATH],
    ['entitlement-apply', ENTITLEMENT_APPLY_PATH],
    ['package-apply', PACKAGE_APPLY_PATH],
  ]) {
    const match = path.match(pattern);
    if (!match || !isInternalUuid(match[1])) continue;
    if (match[2] !== undefined && !isPlatformSafeCode(match[2])) continue;
    return Object.freeze({
      type,
      tenantId: match[1].toLowerCase(),
      ...(match[2] === undefined ? {} : { packageId: match[2] }),
    });
  }
  return null;
}

function routeClaim({ path }) {
  if (path === PLATFORM_CAPABILITIES_PATH) return PLATFORM_HTTP_ROUTE.CAPABILITIES;
  if (path === PLATFORM_PACKAGES_PATH) return PLATFORM_HTTP_ROUTE.PACKAGES;
  const match = matched(path);
  if (match?.type === 'entitlements') return PLATFORM_HTTP_ROUTE.TENANT_ENTITLEMENTS;
  if (match?.type === 'entitlement-preview') return PLATFORM_HTTP_ROUTE.ENTITLEMENT_PREVIEW;
  if (match?.type === 'package-preview') return PLATFORM_HTTP_ROUTE.PACKAGE_PREVIEW;
  if (match?.type === 'entitlement-apply') return PLATFORM_HTTP_ROUTE.ENTITLEMENT_APPLY;
  if (match?.type === 'package-apply') return PLATFORM_HTTP_ROUTE.PACKAGE_APPLY;
  return null;
}

export const platformEntitlementRoutes = definePlatformRouteModule({
  id: 'platform-entitlements',
  claim: routeClaim,
  createHandler({
    platformEntitlementOperationsService,
    platformPrincipalGuard,
    maxBodyBytes,
    maxResponseBytes,
  }) {
    const service = platformEntitlementOperationsService;
    if (
      !service
      || typeof service.listCapabilities !== 'function'
      || typeof service.listPackages !== 'function'
      || typeof service.getTenantEntitlements !== 'function'
      || typeof service.previewEntitlementChanges !== 'function'
      || typeof service.previewPackage !== 'function'
      || typeof service.applyEntitlementChanges !== 'function'
      || typeof service.applyPackage !== 'function'
    ) throw new TypeError('PLATFORM_ENTITLEMENT_OPERATIONS_SERVICE_REQUIRED');
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }

    return async function handle({ path, parsedUrl, request, response, requestId }) {
      const match = matched(path);
      if (path !== PLATFORM_CAPABILITIES_PATH && path !== PLATFORM_PACKAGES_PATH && match === null) {
        return null;
      }

      if (path === PLATFORM_CAPABILITIES_PATH) {
        if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
        assertPlatformNoQuery(parsedUrl);
        const operatorContext = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        sendPlatformJson(
          response,
          200,
          await service.listCapabilities({ operatorContext }),
          maxResponseBytes,
        );
        return 200;
      }

      if (path === PLATFORM_PACKAGES_PATH) {
        if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
        const operatorContext = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        sendPlatformJson(
          response,
          200,
          await service.listPackages({ operatorContext, query: packageQuery(parsedUrl) }),
          maxResponseBytes,
        );
        return 200;
      }

      assertPlatformNoQuery(parsedUrl);
      if (match.type === 'entitlements' || match.type === 'package-preview') {
        if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
        const operatorContext = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        const result = match.type === 'entitlements'
          ? await service.getTenantEntitlements({ operatorContext, tenantId: match.tenantId })
          : await service.previewPackage({
            operatorContext,
            tenantId: match.tenantId,
            packageId: match.packageId,
          });
        sendPlatformJson(response, 200, result, maxResponseBytes);
        return 200;
      }

      if (request.method !== 'POST') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      const isApplication = match.type === 'entitlement-apply' || match.type === 'package-apply';
      const authority = await platformMutationAuthority({
        platformPrincipalGuard,
        request,
        correlationId: requestId,
        idempotent: isApplication,
      });
      const rawBody = await readPlatformJsonObject(request, { maxBytes: maxBodyBytes });
      let result;
      if (match.type === 'entitlement-preview') {
        result = await service.previewEntitlementChanges({
          operatorContext: authority.operatorContext,
          tenantId: match.tenantId,
          ...previewBody(rawBody),
        });
      } else if (match.type === 'entitlement-apply') {
        result = await service.applyEntitlementChanges({
          ...authority,
          tenantId: match.tenantId,
          ...entitlementApplyBody(rawBody, match.tenantId),
          correlationId: requestId,
        });
      } else {
        result = await service.applyPackage({
          ...authority,
          tenantId: match.tenantId,
          packageId: match.packageId,
          ...packageApplyBody(rawBody, match.tenantId),
          correlationId: requestId,
        });
      }
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
