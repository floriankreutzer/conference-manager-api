import { createHash } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformAuthorizationError } from '../identity/errors.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import {
  PlatformOperationDeniedError,
  PlatformOperationInputError,
  PlatformOperationUnavailableError,
} from './platform-operation-errors.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CURSOR_PATTERN = /^[A-Za-z0-9_.-]{1,4096}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;

export const PLATFORM_OPERATION = Object.freeze({
  TENANT_DIRECTORY_READ: 'tenant.directory.read',
  TENANT_INVITATION_CREATE: 'tenant.invitation.create',
  INVITATION_REVOKE: 'tenant.invitation.revoke',
  INVITATION_REISSUE: 'tenant.invitation.reissue',
  LIFECYCLE_TRANSITION: 'tenant.lifecycle.transition',
  ENTITLEMENT_READ: 'tenant.entitlement.read',
  ENTITLEMENT_APPLY: 'tenant.entitlement.apply',
  READINESS_READ: 'tenant.readiness.read',
  MICROSOFT_HEALTH_READ: 'tenant.microsoft_health.read',
  DIAGNOSTIC_SUMMARY_READ: 'tenant.diagnostics.summary.read',
  DIAGNOSTIC_CORRELATION_READ: 'tenant.diagnostics.correlation.read',
  RECOVER_LAST_TENANT_ADMIN: 'tenant.recovery.last_admin',
  INITIATE_MICROSOFT_RECONSENT: 'tenant.recovery.microsoft_reconsent',
  REPAIR_ROOM_MAPPING: 'tenant.recovery.room_mapping',
  UNBIND_TENANT_IDENTITY: 'tenant.recovery.identity_unbind',
  REVOKE_TENANT_SESSIONS: 'tenant.recovery.tenant_sessions',
  REVOKE_USER_SESSIONS: 'tenant.recovery.user_sessions',
  RECOVERY_SUSPEND_TENANT: 'tenant.recovery.suspend',
  RECOVERY_REACTIVATE_TENANT: 'tenant.recovery.reactivate',
});

const PERMISSION_BY_OPERATION = new Map([
  [PLATFORM_OPERATION.TENANT_DIRECTORY_READ, PLATFORM_PERMISSION.TENANT_READ],
  [PLATFORM_OPERATION.TENANT_INVITATION_CREATE, PLATFORM_PERMISSION.INVITATION_MANAGE],
  [PLATFORM_OPERATION.INVITATION_REVOKE, PLATFORM_PERMISSION.INVITATION_MANAGE],
  [PLATFORM_OPERATION.INVITATION_REISSUE, PLATFORM_PERMISSION.INVITATION_MANAGE],
  [PLATFORM_OPERATION.LIFECYCLE_TRANSITION, PLATFORM_PERMISSION.LIFECYCLE_MANAGE],
  [PLATFORM_OPERATION.ENTITLEMENT_READ, PLATFORM_PERMISSION.ENTITLEMENT_READ],
  [PLATFORM_OPERATION.ENTITLEMENT_APPLY, PLATFORM_PERMISSION.ENTITLEMENT_MANAGE],
  [PLATFORM_OPERATION.READINESS_READ, PLATFORM_PERMISSION.READINESS_READ],
  [PLATFORM_OPERATION.MICROSOFT_HEALTH_READ, PLATFORM_PERMISSION.INTEGRATION_HEALTH_READ],
  [PLATFORM_OPERATION.DIAGNOSTIC_SUMMARY_READ, PLATFORM_PERMISSION.DIAGNOSTICS_READ],
  [PLATFORM_OPERATION.DIAGNOSTIC_CORRELATION_READ, PLATFORM_PERMISSION.DIAGNOSTICS_SENSITIVE],
  [PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
  [PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
  [PLATFORM_OPERATION.REPAIR_ROOM_MAPPING, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
  [PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
  [PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS, PLATFORM_PERMISSION.SESSION_REVOKE],
  [PLATFORM_OPERATION.REVOKE_USER_SESSIONS, PLATFORM_PERMISSION.SESSION_REVOKE],
  [PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
  [PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT, PLATFORM_PERMISSION.RECOVERY_EXECUTE],
]);

export function inputError(code) {
  return new PlatformOperationInputError(code);
}

export function requireExactObject(value, allowedKeys, requiredKeys = allowedKeys, code = 'PLATFORM_OPERATION_INPUT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError(code);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw inputError(code);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) throw inputError(code);
  return value;
}

export function requireInternalId(value, code = 'PLATFORM_OPERATION_ID_INVALID') {
  if (!isInternalUuid(value)) throw inputError(code);
  return value.toLowerCase();
}

export function requireRevision(value, code = 'PLATFORM_OPERATION_REVISION_INVALID') {
  if (!Number.isSafeInteger(value) || value < 1) throw inputError(code);
  return value;
}

export function requireCount(value, code = 'PLATFORM_OPERATION_COUNT_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) throw inputError(code);
  return value;
}

export function requireBoolean(value, code = 'PLATFORM_OPERATION_BOOLEAN_INVALID') {
  if (typeof value !== 'boolean') throw inputError(code);
  return value;
}

export function requireBoundedText(value, {
  minimum = 1,
  maximum,
  pattern,
  trim = true,
  code = 'PLATFORM_OPERATION_TEXT_INVALID',
} = {}) {
  if (typeof value !== 'string') throw inputError(code);
  if (trim && value.trim() !== value) throw inputError(code);
  if (value.length < minimum || value.length > maximum || CONTROL_CHARACTERS.test(value)) throw inputError(code);
  if (pattern && !pattern.test(value)) throw inputError(code);
  return value;
}

export function requireSafeCode(value, code = 'PLATFORM_OPERATION_CODE_INVALID') {
  return requireBoundedText(value, { maximum: 96, pattern: SAFE_CODE_PATTERN, code });
}

export function requireRelease(value, code = 'PLATFORM_OPERATION_RELEASE_INVALID') {
  return requireBoundedText(value, { maximum: 80, pattern: RELEASE_PATTERN, code });
}

export function requireTimestamp(value, code = 'PLATFORM_OPERATION_TIMESTAMP_INVALID') {
  if (typeof value !== 'string') throw inputError(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw inputError(code);
  return value;
}

export function optionalTimestamp(value, code = 'PLATFORM_OPERATION_TIMESTAMP_INVALID') {
  return value === null ? null : requireTimestamp(value, code);
}

export function requireReason(value) {
  return requireBoundedText(value, { maximum: 500, code: 'PLATFORM_OPERATION_REASON_INVALID' });
}

export function requireDisplayName(value) {
  return requireBoundedText(value, { maximum: 160, code: 'PLATFORM_TENANT_DISPLAY_NAME_INVALID' });
}

export function requireCursor(value) {
  if (value === null) return null;
  return requireBoundedText(value, {
    maximum: 4096,
    pattern: CURSOR_PATTERN,
    trim: false,
    code: 'PLATFORM_OPERATION_CURSOR_INVALID',
  });
}

export function requireLimit(value, { defaultValue = 25, maximum = 100 } = {}) {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw inputError('PLATFORM_OPERATION_LIMIT_INVALID');
  }
  return value;
}

export function requireClockTime(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw inputError('PLATFORM_OPERATION_CLOCK_INVALID');
  return value;
}

export function requireConfirmation(value, { action, tenantId }) {
  requireExactObject(
    value,
    ['action', 'tenantId'],
    ['action', 'tenantId'],
    'PLATFORM_OPERATION_CONFIRMATION_INVALID',
  );
  if (value.action !== action || requireInternalId(value.tenantId) !== tenantId) {
    throw inputError('PLATFORM_OPERATION_CONFIRMATION_INVALID');
  }
  return Object.freeze({ action, tenantId });
}

export function requirePort(value, methods, code) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(code);
  return value;
}

export function platformPermissionForOperation(operation) {
  const permission = PERMISSION_BY_OPERATION.get(operation);
  if (!permission) throw new TypeError('PLATFORM_OPERATION_UNKNOWN');
  return permission;
}

export function operationRequestDigest(value) {
  requireExactObject(value, Object.keys(value));
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

export async function authorizePlatformOperation({
  authorizationPolicy,
  tenantTargetPolicy,
  operatorContext,
  operation,
  tenantId = null,
  fleet = false,
  tenantCreation = false,
}) {
  if (!operatorContext || typeof operatorContext !== 'object' || Array.isArray(operatorContext)) {
    throw new PlatformOperationDeniedError();
  }
  const permission = platformPermissionForOperation(operation);
  let authorized;
  try {
    authorized = await authorizationPolicy.authorize(operatorContext, permission);
  } catch (error) {
    if (error instanceof PlatformAuthorizationError) {
      throw new PlatformOperationDeniedError(error.code);
    }
    throw error;
  }
  if (authorized !== true) {
    throw new PlatformOperationDeniedError();
  }
  let targetAuthorization;
  try {
    if (tenantCreation) {
      if (tenantId !== null || fleet) throw new TypeError('PLATFORM_OPERATION_TARGET_SCOPE_INVALID');
      targetAuthorization = await tenantTargetPolicy.authorizeCreation(operatorContext);
      if (targetAuthorization !== true) {
        throw new PlatformOperationDeniedError();
      }
    } else if (tenantId !== null) {
      targetAuthorization = await tenantTargetPolicy.authorize(operatorContext, tenantId);
      if (targetAuthorization !== true) throw new PlatformOperationDeniedError();
    } else if (fleet) {
      targetAuthorization = await tenantTargetPolicy.queryScope(operatorContext);
      if (!targetAuthorization || typeof targetAuthorization !== 'object' || Array.isArray(targetAuthorization)) {
        throw new PlatformOperationDeniedError();
      }
      targetAuthorization = Object.freeze({ ...targetAuthorization });
    } else {
      throw new TypeError('PLATFORM_OPERATION_TARGET_SCOPE_REQUIRED');
    }
  } catch (error) {
    if (error instanceof PlatformAuthorizationError) {
      throw new PlatformOperationDeniedError(error.code);
    }
    throw error;
  }
  return Object.freeze({
    principal: operatorContext,
    permission,
    operation,
    targetTenantId: tenantId,
    targetAuthorization,
  });
}

export async function createMutationEvidence({
  evidenceFactory,
  authorization,
  operation,
  tenantId,
  correlationId,
  reason,
  target,
  previousState,
  requestedState,
  occurredAt,
}) {
  const evidence = await evidenceFactory.createMutation({
    authorization,
    operation,
    tenantId,
    correlationId,
    reason,
    target,
    previousState,
    requestedState,
    occurredAt,
  });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new PlatformOperationUnavailableError('PLATFORM_OPERATION_EVIDENCE_INVALID');
  }
  return evidence;
}

export async function createSensitiveReadEvidence({
  evidenceFactory,
  authorization,
  operation,
  tenantId,
  correlationId,
  target,
  occurredAt,
}) {
  const evidence = await evidenceFactory.createSensitiveRead({
    authorization,
    operation,
    tenantId,
    correlationId,
    target,
    occurredAt,
  });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new PlatformOperationUnavailableError('PLATFORM_OPERATION_EVIDENCE_INVALID');
  }
  return evidence;
}

export function requirePage(value, code = 'PLATFORM_OPERATION_PAGE_INVALID') {
  requireExactObject(value, ['items', 'nextCursor', 'snapshotAt'], ['items', 'nextCursor', 'snapshotAt'], code);
  if (!Array.isArray(value.items)) throw inputError(code);
  return Object.freeze({
    items: value.items,
    nextCursor: requireCursor(value.nextCursor),
    snapshotAt: requireTimestamp(value.snapshotAt, code),
  });
}
