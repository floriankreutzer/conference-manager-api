import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformHttpError } from './errors.js';
import { requirePlatformExactObject } from './security.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,95}$/;

function validationFailed() {
  throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
}

export function requirePlatformInternalId(value) {
  if (!isInternalUuid(value)) validationFailed();
  return value.toLowerCase();
}

export function requirePlatformIdempotencyKey(request) {
  const value = request?.headers?.['idempotency-key'];
  if (Array.isArray(value) || !isInternalUuid(value)) {
    throw new PlatformHttpError(400, 'PLATFORM_IDEMPOTENCY_KEY_INVALID');
  }
  return value.toLowerCase();
}

export function isPlatformBoundedText(value, maximum, { minimum = 1 } = {}) {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum
    && value.trim() === value
    && !CONTROL_CHARACTERS.test(value);
}

export function isPlatformSafeCode(value) {
  return typeof value === 'string' && SAFE_CODE.test(value);
}

export function isPlatformPositiveRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

export function isPlatformNonnegativeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isPlatformCanonicalInstant(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function requirePlatformTenantConfirmation(value, { action, tenantId }) {
  const confirmation = requirePlatformExactObject(value, {
    required: {
      action: (candidate) => candidate === action,
      tenantId: (candidate) => (
        isInternalUuid(candidate) && candidate.toLowerCase() === tenantId
      ),
    },
  });
  return Object.freeze({ action, tenantId });
}

export async function platformMutationAuthority({
  platformPrincipalGuard,
  request,
  correlationId,
  idempotent = true,
}) {
  const operatorContext = await platformPrincipalGuard.require(request, {
    csrf: true,
    correlationId,
  });
  return Object.freeze({
    operatorContext,
    ...(idempotent ? { idempotencyKey: requirePlatformIdempotencyKey(request) } : {}),
  });
}
