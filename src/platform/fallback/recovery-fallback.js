import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_BREAK_GLASS_TOKEN_PATTERN } from '../identity/break-glass.js';
import {
  PLATFORM_SESSION_COOKIE_NAME,
  PLATFORM_SESSION_TOKEN_PATTERN,
} from '../identity/session-cookie.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { PLATFORM_OPERATION } from '../application/platform-operation-contract.js';

const CONTROL = /[\u0000-\u001f\u007f]/;
const DEFINITIONS = Object.freeze({
  'last-tenant-admin': Object.freeze({
    action: PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    targetField: 'targetUserId',
    preview: 'previewLastTenantAdmin',
    execute: 'recoverLastTenantAdmin',
  }),
  'microsoft-reconsent': Object.freeze({
    action: PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    targetField: null,
    preview: 'previewMicrosoftReconsent',
    execute: 'initiateMicrosoftReconsent',
  }),
  'room-mapping-repair': Object.freeze({
    action: PLATFORM_OPERATION.REPAIR_ROOM_MAPPING,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    targetField: 'mappingId',
    preview: 'previewRoomMappingRepair',
    execute: 'repairRoomMapping',
  }),
  'identity-unbind': Object.freeze({
    action: PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    targetField: null,
    preview: 'previewIdentityUnbind',
    execute: 'unbindTenantIdentity',
  }),
  'tenant-session-revocation': Object.freeze({
    action: PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS,
    permission: PLATFORM_PERMISSION.SESSION_REVOKE,
    targetField: null,
    preview: 'previewTenantSessionRevocation',
    execute: 'revokeTenantSessions',
  }),
  'user-session-revocation': Object.freeze({
    action: PLATFORM_OPERATION.REVOKE_USER_SESSIONS,
    permission: PLATFORM_PERMISSION.SESSION_REVOKE,
    targetField: 'targetUserId',
    preview: 'previewUserSessionRevocation',
    execute: 'revokeUserSessions',
  }),
  'tenant-suspension': Object.freeze({
    action: PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    targetField: null,
    preview: 'previewTenantSuspension',
    execute: 'suspendTenant',
  }),
  'tenant-reactivation': Object.freeze({
    action: PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    targetField: null,
    preview: 'previewTenantReactivation',
    execute: 'reactivateTenant',
  }),
});

function invalid(code = 'PLATFORM_FALLBACK_INPUT_INVALID') {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function exact(value, keys) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  ) invalid();
  return value;
}

function internalId(value) {
  if (!isInternalUuid(value)) invalid();
  return value.toLowerCase();
}

export function normalizePlatformRecoveryFallbackRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const definition = DEFINITIONS[value.operation];
  if (!definition) invalid('PLATFORM_FALLBACK_OPERATION_INVALID');
  const keys = [
    'version', 'sessionToken', 'grantToken', 'operation', 'tenantId', 'reason',
    'confirmation', 'correlationId', 'idempotencyKey',
    ...(definition.targetField ? [definition.targetField] : []),
  ];
  exact(value, keys);
  if (
    value.version !== 1
    || !PLATFORM_SESSION_TOKEN_PATTERN.test(value.sessionToken || '')
    || !PLATFORM_BREAK_GLASS_TOKEN_PATTERN.test(value.grantToken || '')
    || typeof value.reason !== 'string'
    || value.reason.trim() !== value.reason
    || value.reason.length < 10
    || value.reason.length > 500
    || CONTROL.test(value.reason)
  ) invalid();
  const tenantId = internalId(value.tenantId);
  exact(value.confirmation, ['action', 'tenantId']);
  if (
    value.confirmation.action !== definition.action
    || internalId(value.confirmation.tenantId) !== tenantId
  ) invalid('PLATFORM_FALLBACK_CONFIRMATION_INVALID');
  return Object.freeze({
    version: 1,
    sessionToken: value.sessionToken,
    grantToken: value.grantToken,
    operation: value.operation,
    tenantId,
    reason: value.reason,
    confirmation: Object.freeze({ action: definition.action, tenantId }),
    correlationId: internalId(value.correlationId),
    idempotencyKey: internalId(value.idempotencyKey),
    ...(definition.targetField ? { [definition.targetField]: internalId(value[definition.targetField]) } : {}),
  });
}

export async function executePlatformRecoveryFallback({ request: requestValue, services } = {}) {
  const request = normalizePlatformRecoveryFallbackRequest(requestValue);
  const definition = DEFINITIONS[request.operation];
  if (
    !services
    || typeof services.sessionService?.resolvePrincipal !== 'function'
    || typeof services.breakGlassService?.execute !== 'function'
    || typeof services.recoveryService?.[definition.preview] !== 'function'
    || typeof services.recoveryService?.[definition.execute] !== 'function'
  ) invalid('PLATFORM_FALLBACK_SERVICES_INVALID');
  const operatorContext = await services.sessionService.resolvePrincipal({
    headers: { cookie: `${PLATFORM_SESSION_COOKIE_NAME}=${request.sessionToken}` },
  });
  if (!operatorContext) invalid('PLATFORM_FALLBACK_SESSION_INVALID');
  const target = definition.targetField
    ? { [definition.targetField]: request[definition.targetField] }
    : {};
  const preview = await services.recoveryService[definition.preview]({
    operatorContext,
    tenantId: request.tenantId,
    correlationId: request.correlationId,
    ...target,
  });
  return services.breakGlassService.execute({
    principal: operatorContext,
    token: request.grantToken,
    targetTenantId: request.tenantId,
    permission: definition.permission,
    correlationId: request.correlationId,
    mutation: () => services.recoveryService[definition.execute]({
      operatorContext,
      tenantId: request.tenantId,
      recoveryContextId: preview.recoveryContextId,
      reason: request.reason,
      confirmation: request.confirmation,
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      ...target,
    }),
  });
}
