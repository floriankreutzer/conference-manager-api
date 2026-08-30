import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_PERMISSION } from './policy.js';

export const PLATFORM_BREAK_GLASS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BREAK_GLASS_PERMISSIONS = new Set([
  PLATFORM_PERMISSION.LIFECYCLE_MANAGE,
  PLATFORM_PERMISSION.ENTITLEMENT_MANAGE,
  PLATFORM_PERMISSION.RECOVERY_EXECUTE,
  PLATFORM_PERMISSION.SESSION_REVOKE,
]);
const APPROVAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;

export function hashPlatformBreakGlassToken(token) {
  if (!PLATFORM_BREAK_GLASS_TOKEN_PATTERN.test(token || '')) {
    throw new TypeError('PLATFORM_BREAK_GLASS_TOKEN_INVALID');
  }
  return createHash('sha256')
    .update(`platform-break-glass:v1:${token}`, 'ascii')
    .digest('hex');
}

export function createPlatformBreakGlassGrant({
  operatorId,
  operatorSecurityVersion,
  approverOperatorId,
  approverSecurityVersion,
  targetTenantId,
  permission,
  reason,
  approvalReference,
  ttlSeconds,
  tokenFactory = () => randomBytes(32).toString('base64url'),
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !isInternalUuid(operatorId)
    || !Number.isSafeInteger(operatorSecurityVersion)
    || operatorSecurityVersion < 1
    || !isInternalUuid(approverOperatorId)
    || !Number.isSafeInteger(approverSecurityVersion)
    || approverSecurityVersion < 1
    || operatorId === approverOperatorId
    || !isInternalUuid(targetTenantId)
  ) throw new TypeError('PLATFORM_BREAK_GLASS_PARTIES_INVALID');
  if (!BREAK_GLASS_PERMISSIONS.has(permission)) {
    throw new TypeError('PLATFORM_BREAK_GLASS_PERMISSION_INVALID');
  }
  if (
    typeof reason !== 'string'
    || reason.trim() !== reason
    || reason.length < 10
    || reason.length > 512
    || /[\u0000-\u001f\u007f]/.test(reason)
  ) throw new TypeError('PLATFORM_BREAK_GLASS_REASON_INVALID');
  if (typeof approvalReference !== 'string' || !APPROVAL_REFERENCE_PATTERN.test(approvalReference)) {
    throw new TypeError('PLATFORM_BREAK_GLASS_APPROVAL_INVALID');
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1_800) {
    throw new TypeError('PLATFORM_BREAK_GLASS_TTL_INVALID');
  }
  const id = idFactory();
  const token = tokenFactory();
  if (!isInternalUuid(id) || !PLATFORM_BREAK_GLASS_TOKEN_PATTERN.test(token || '')) {
    throw new TypeError('PLATFORM_BREAK_GLASS_FACTORY_INVALID');
  }
  return Object.freeze({
    token,
    record: Object.freeze({
      id,
      tokenHash: hashPlatformBreakGlassToken(token),
      operatorId,
      operatorSecurityVersion,
      approverOperatorId,
      approverSecurityVersion,
      targetTenantId,
      permission,
      reason,
      approvalReference,
      ttlSeconds,
    }),
  });
}

export function normalizePlatformBreakGlassConsumption({
  token,
  operatorId,
  operatorSecurityVersion,
  targetTenantId,
  permission,
} = {}) {
  if (
    !isInternalUuid(operatorId)
    || !Number.isSafeInteger(operatorSecurityVersion)
    || operatorSecurityVersion < 1
    || !isInternalUuid(targetTenantId)
  ) {
    throw new TypeError('PLATFORM_BREAK_GLASS_SCOPE_INVALID');
  }
  if (!BREAK_GLASS_PERMISSIONS.has(permission)) {
    throw new TypeError('PLATFORM_BREAK_GLASS_PERMISSION_INVALID');
  }
  return Object.freeze({
    tokenHash: hashPlatformBreakGlassToken(token),
    operatorId,
    operatorSecurityVersion,
    targetTenantId,
    permission,
  });
}

export function createPlatformBreakGlassAuthorizationContext(value) {
  const issuedAt = Date.parse(value?.issuedAt);
  const consumedAt = Date.parse(value?.consumedAt);
  const expiresAt = Date.parse(value?.expiresAt);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',')
      !== 'approvalReference,approverOperatorId,consumedAt,expiresAt,id,issuedAt,operatorId,permission,reason,targetTenantId'
    || !isInternalUuid(value.id)
    || !isInternalUuid(value.operatorId)
    || !isInternalUuid(value.approverOperatorId)
    || value.operatorId === value.approverOperatorId
    || !isInternalUuid(value.targetTenantId)
    || !BREAK_GLASS_PERMISSIONS.has(value.permission)
    || typeof value.approvalReference !== 'string'
    || !APPROVAL_REFERENCE_PATTERN.test(value.approvalReference)
    || typeof value.reason !== 'string'
    || value.reason.trim() !== value.reason
    || value.reason.length < 10
    || value.reason.length > 512
    || /[\u0000-\u001f\u007f]/.test(value.reason)
    || !Number.isFinite(issuedAt)
    || new Date(issuedAt).toISOString() !== value.issuedAt
    || !Number.isFinite(consumedAt)
    || new Date(consumedAt).toISOString() !== value.consumedAt
    || !Number.isFinite(expiresAt)
    || new Date(expiresAt).toISOString() !== value.expiresAt
    || issuedAt > consumedAt
    || consumedAt >= expiresAt
  ) throw new TypeError('PLATFORM_BREAK_GLASS_AUTHORIZATION_INVALID');
  return Object.freeze({
    kind: 'platform_break_glass',
    grantId: value.id,
    operatorId: value.operatorId,
    approverOperatorId: value.approverOperatorId,
    targetTenantId: value.targetTenantId,
    permission: value.permission,
    approvalReference: value.approvalReference,
    expiresAt: value.expiresAt,
  });
}
