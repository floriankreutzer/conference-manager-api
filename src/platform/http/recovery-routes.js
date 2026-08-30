import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_OPERATION } from '../application/platform-operation-contract.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import {
  isPlatformBoundedText,
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

const RECOVERY_PATH = new RegExp(
  '^/api/v1/platform/tenants/([0-9a-f-]{36})/recovery/'
  + '(last-tenant-admin|microsoft-reconsent|room-mapping-repair|identity-unbind'
  + '|tenant-session-revocation|user-session-revocation|tenant-suspension|tenant-reactivation)'
  + '/(previews|executions|targets)$',
  'i',
);

const RECOVERY_DEFINITIONS = Object.freeze({
  'last-tenant-admin': Object.freeze({
    action: PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN,
    targetField: 'targetUserId',
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_LAST_ADMIN_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_LAST_ADMIN_EXECUTE,
  }),
  'microsoft-reconsent': Object.freeze({
    action: PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT,
    targetField: null,
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_MICROSOFT_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_MICROSOFT_EXECUTE,
  }),
  'room-mapping-repair': Object.freeze({
    action: PLATFORM_OPERATION.REPAIR_ROOM_MAPPING,
    targetField: 'mappingId',
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_MAPPING_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_MAPPING_EXECUTE,
  }),
  'identity-unbind': Object.freeze({
    action: PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY,
    targetField: null,
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_IDENTITY_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_IDENTITY_EXECUTE,
  }),
  'tenant-session-revocation': Object.freeze({
    action: PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS,
    targetField: null,
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_TENANT_SESSIONS_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_TENANT_SESSIONS_EXECUTE,
  }),
  'user-session-revocation': Object.freeze({
    action: PLATFORM_OPERATION.REVOKE_USER_SESSIONS,
    targetField: 'targetUserId',
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_USER_SESSIONS_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_USER_SESSIONS_EXECUTE,
  }),
  'tenant-suspension': Object.freeze({
    action: PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT,
    targetField: null,
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_SUSPEND_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_SUSPEND_EXECUTE,
  }),
  'tenant-reactivation': Object.freeze({
    action: PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT,
    targetField: null,
    previewRoute: PLATFORM_HTTP_ROUTE.RECOVERY_REACTIVATE_PREVIEW,
    executeRoute: PLATFORM_HTTP_ROUTE.RECOVERY_REACTIVATE_EXECUTE,
  }),
});

function matched(path) {
  const match = path.match(RECOVERY_PATH);
  if (!match || !isInternalUuid(match[1])) return null;
  const slug = match[2].toLowerCase();
  const stage = match[3].toLowerCase();
  const definition = RECOVERY_DEFINITIONS[slug];
  if (!definition) return null;
  if (stage === 'targets' && !definition.targetField) return null;
  return Object.freeze({
    tenantId: match[1].toLowerCase(),
    slug,
    stage,
    definition,
  });
}

const TARGET_CURSOR = /^[A-Za-z0-9_.-]{1,4096}$/;

function targetQuery(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!['limit', 'cursor'].includes(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
    }
  }
  const rawLimit = parsedUrl.searchParams.get('limit');
  const rawCursor = parsedUrl.searchParams.get('cursor');
  if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  if (rawCursor !== null && !TARGET_CURSOR.test(rawCursor)) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  return Object.freeze({ limit: rawLimit === null ? 50 : Number(rawLimit), cursor: rawCursor });
}

function previewBody(value, definition) {
  if (definition.targetField === null) {
    requirePlatformExactObject(value);
    return Object.freeze({});
  }
  const body = requirePlatformExactObject(value, {
    required: {
      [definition.targetField]: isInternalUuid,
    },
  });
  return Object.freeze({ [definition.targetField]: body[definition.targetField].toLowerCase() });
}

function executionBody(value, tenantId, definition) {
  const body = requirePlatformExactObject(value, {
    required: {
      recoveryContextId: isInternalUuid,
      reason: (candidate) => isPlatformBoundedText(candidate, 500),
      confirmation: (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate),
      ...(definition.targetField === null ? {} : { [definition.targetField]: isInternalUuid }),
    },
  });
  return Object.freeze({
    recoveryContextId: body.recoveryContextId.toLowerCase(),
    reason: body.reason,
    confirmation: requirePlatformTenantConfirmation(body.confirmation, {
      action: definition.action,
      tenantId,
    }),
    ...(definition.targetField === null
      ? {}
      : { [definition.targetField]: body[definition.targetField].toLowerCase() }),
  });
}

function requireRecoveryService(service) {
  const methods = [
    'previewLastTenantAdmin',
    'recoverLastTenantAdmin',
    'previewMicrosoftReconsent',
    'initiateMicrosoftReconsent',
    'previewRoomMappingRepair',
    'repairRoomMapping',
    'previewIdentityUnbind',
    'unbindTenantIdentity',
    'previewTenantSessionRevocation',
    'revokeTenantSessions',
    'previewUserSessionRevocation',
    'revokeUserSessions',
    'previewTenantSuspension',
    'suspendTenant',
    'previewTenantReactivation',
    'reactivateTenant',
    'listRecoveryTargets',
  ];
  if (!service || methods.some((method) => typeof service[method] !== 'function')) {
    throw new TypeError('PLATFORM_RECOVERY_OPERATIONS_SERVICE_REQUIRED');
  }
  return service;
}

function previewRecovery(service, slug, input) {
  if (slug === 'last-tenant-admin') return service.previewLastTenantAdmin(input);
  if (slug === 'microsoft-reconsent') return service.previewMicrosoftReconsent(input);
  if (slug === 'room-mapping-repair') return service.previewRoomMappingRepair(input);
  if (slug === 'identity-unbind') return service.previewIdentityUnbind(input);
  if (slug === 'tenant-session-revocation') return service.previewTenantSessionRevocation(input);
  if (slug === 'user-session-revocation') return service.previewUserSessionRevocation(input);
  if (slug === 'tenant-suspension') return service.previewTenantSuspension(input);
  return service.previewTenantReactivation(input);
}

function executeRecovery(service, slug, input) {
  if (slug === 'last-tenant-admin') return service.recoverLastTenantAdmin(input);
  if (slug === 'microsoft-reconsent') return service.initiateMicrosoftReconsent(input);
  if (slug === 'room-mapping-repair') return service.repairRoomMapping(input);
  if (slug === 'identity-unbind') return service.unbindTenantIdentity(input);
  if (slug === 'tenant-session-revocation') return service.revokeTenantSessions(input);
  if (slug === 'user-session-revocation') return service.revokeUserSessions(input);
  if (slug === 'tenant-suspension') return service.suspendTenant(input);
  return service.reactivateTenant(input);
}

export const platformRecoveryRoutes = definePlatformRouteModule({
  id: 'platform-recovery',
  claim({ path }) {
    const match = matched(path);
    if (match === null) return null;
    if (match.stage === 'targets') return PLATFORM_HTTP_ROUTE.RECOVERY_TARGETS;
    return match.stage === 'previews'
      ? match.definition.previewRoute
      : match.definition.executeRoute;
  },
  createHandler({
    platformRecoveryOperationsService,
    platformPrincipalGuard,
    maxBodyBytes,
    maxResponseBytes,
  }) {
    const service = requireRecoveryService(platformRecoveryOperationsService);
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      const match = matched(path);
      if (match === null) return null;
      if (match.stage === 'targets') {
        if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
        const operatorContext = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        const result = await service.listRecoveryTargets({
          operatorContext,
          tenantId: match.tenantId,
          operation: match.slug,
          correlationId: requestId,
          ...targetQuery(parsedUrl),
        });
        sendPlatformJson(response, 200, result, maxResponseBytes);
        return 200;
      }
      if (request.method !== 'POST') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      assertPlatformNoQuery(parsedUrl);
      const isExecution = match.stage === 'executions';
      const authority = await platformMutationAuthority({
        platformPrincipalGuard,
        request,
        correlationId: requestId,
        idempotent: isExecution,
      });
      const body = await readPlatformJsonObject(request, { maxBytes: maxBodyBytes });
      const input = Object.freeze({
        ...authority,
        tenantId: match.tenantId,
        ...(isExecution
          ? executionBody(body, match.tenantId, match.definition)
          : previewBody(body, match.definition)),
        correlationId: requestId,
      });
      const result = isExecution
        ? await executeRecovery(service, match.slug, input)
        : await previewRecovery(service, match.slug, input);
      sendPlatformJson(response, 200, result, maxResponseBytes);
      return 200;
    };
  },
});
