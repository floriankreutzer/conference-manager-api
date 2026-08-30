import { isInternalUuid } from '../../domain/identifiers.js';
import {
  PLATFORM_SESSION_COOKIE_NAME,
  PLATFORM_SESSION_TOKEN_PATTERN,
} from '../identity/session-cookie.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';

const ALLOWED_PERMISSIONS = new Set([
  PLATFORM_PERMISSION.LIFECYCLE_MANAGE,
  PLATFORM_PERMISSION.ENTITLEMENT_MANAGE,
  PLATFORM_PERMISSION.RECOVERY_EXECUTE,
  PLATFORM_PERMISSION.SESSION_REVOKE,
]);
const APPROVAL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(code = 'PLATFORM_FALLBACK_GRANT_INPUT_INVALID') {
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
}

function uuid(value) {
  if (!isInternalUuid(value)) invalid();
  return value.toLowerCase();
}

export function normalizePlatformFallbackGrantRequest(value) {
  exact(value, [
    'version', 'principalSessionToken', 'approverSessionToken', 'targetTenantId',
    'permission', 'reason', 'approvalReference', 'ttlSeconds', 'correlationId',
  ]);
  if (
    value.version !== 1
    || !PLATFORM_SESSION_TOKEN_PATTERN.test(value.principalSessionToken || '')
    || !PLATFORM_SESSION_TOKEN_PATTERN.test(value.approverSessionToken || '')
    || value.principalSessionToken === value.approverSessionToken
    || !ALLOWED_PERMISSIONS.has(value.permission)
    || typeof value.reason !== 'string'
    || value.reason.trim() !== value.reason
    || value.reason.length < 10
    || value.reason.length > 512
    || CONTROL.test(value.reason)
    || !APPROVAL.test(value.approvalReference || '')
    || !Number.isSafeInteger(value.ttlSeconds)
    || value.ttlSeconds < 60
    || value.ttlSeconds > 1_800
  ) invalid();
  return Object.freeze({
    ...value,
    targetTenantId: uuid(value.targetTenantId),
    correlationId: uuid(value.correlationId),
  });
}

async function principal(sessionService, token) {
  return sessionService.resolvePrincipal({
    headers: { cookie: `${PLATFORM_SESSION_COOKIE_NAME}=${token}` },
  });
}

export async function issuePlatformFallbackGrant({ request: requestValue, services } = {}) {
  const request = normalizePlatformFallbackGrantRequest(requestValue);
  if (
    typeof services?.sessionService?.resolvePrincipal !== 'function'
    || typeof services?.breakGlassService?.issue !== 'function'
  ) invalid('PLATFORM_FALLBACK_SERVICES_INVALID');
  const [principalValue, approverPrincipal] = await Promise.all([
    principal(services.sessionService, request.principalSessionToken),
    principal(services.sessionService, request.approverSessionToken),
  ]);
  if (!principalValue || !approverPrincipal) invalid('PLATFORM_FALLBACK_SESSION_INVALID');
  return services.breakGlassService.issue({
    principal: principalValue,
    approverPrincipal,
    targetTenantId: request.targetTenantId,
    permission: request.permission,
    reason: request.reason,
    approvalReference: request.approvalReference,
    ttlSeconds: request.ttlSeconds,
    correlationId: request.correlationId,
  });
}
