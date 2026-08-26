import { isInternalUuid } from '../domain/identifiers.js';

export const RESERVATION_PHASE = Object.freeze({
  PROVISIONAL: 'provisional',
  FINAL: 'final',
});

export const PROVIDER_ERROR_KIND = Object.freeze({
  TIMEOUT: 'timeout',
  THROTTLED: 'throttled',
  UNAVAILABLE: 'unavailable',
  AUTHORIZATION: 'authorization',
  VALIDATION: 'validation',
  CONFLICT: 'conflict',
  DUPLICATE: 'duplicate',
  NOT_FOUND: 'not_found',
  MALFORMED_RESPONSE: 'malformed_response',
  UNKNOWN: 'unknown',
});

const RESERVATION_PHASES = new Set(Object.values(RESERVATION_PHASE));
const PROVIDER_ERROR_KINDS = new Set(Object.values(PROVIDER_ERROR_KIND));
const RETRYABLE_ERROR_KINDS = new Set([
  PROVIDER_ERROR_KIND.TIMEOUT,
  PROVIDER_ERROR_KIND.THROTTLED,
  PROVIDER_ERROR_KIND.UNAVAILABLE,
]);
const PROVIDER_REFERENCE_PATTERN = /^[^\u0000-\u001f\u007f]{1,255}$/;
const PROVIDER_RESOURCE_REFERENCE_PATTERN = /^[^\u0000-\u001f\u007f]{3,320}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONFLICT_COUNT = 10_000;
const MAX_RETRY_AFTER_MS = 300_000;

const ERROR_CODE_BY_KIND = Object.freeze({
  [PROVIDER_ERROR_KIND.TIMEOUT]: 'CALENDAR_PROVIDER_TIMEOUT',
  [PROVIDER_ERROR_KIND.THROTTLED]: 'CALENDAR_PROVIDER_THROTTLED',
  [PROVIDER_ERROR_KIND.UNAVAILABLE]: 'CALENDAR_PROVIDER_UNAVAILABLE',
  [PROVIDER_ERROR_KIND.AUTHORIZATION]: 'CALENDAR_PROVIDER_NOT_AUTHORIZED',
  [PROVIDER_ERROR_KIND.VALIDATION]: 'CALENDAR_PROVIDER_VALIDATION_FAILED',
  [PROVIDER_ERROR_KIND.CONFLICT]: 'CALENDAR_PROVIDER_CONFLICT',
  [PROVIDER_ERROR_KIND.DUPLICATE]: 'CALENDAR_PROVIDER_DUPLICATE',
  [PROVIDER_ERROR_KIND.NOT_FOUND]: 'CALENDAR_PROVIDER_NOT_FOUND',
  [PROVIDER_ERROR_KIND.MALFORMED_RESPONSE]: 'CALENDAR_PROVIDER_RESPONSE_INVALID',
  [PROVIDER_ERROR_KIND.UNKNOWN]: 'CALENDAR_PROVIDER_FAILED',
});

function invalidProviderResponse(operation) {
  return new CalendarProviderError(PROVIDER_ERROR_KIND.MALFORMED_RESPONSE, { operation });
}

export function isReservationPhase(value) {
  return RESERVATION_PHASES.has(value);
}

export function isProviderReference(value) {
  return typeof value === 'string'
    && value.trim() === value
    && PROVIDER_REFERENCE_PATTERN.test(value);
}

export function isProviderResourceReference(value) {
  return typeof value === 'string'
    && value.trim() === value
    && PROVIDER_RESOURCE_REFERENCE_PATTERN.test(value);
}

export function isProviderConnectionReference(value) {
  return isProviderResourceReference(value);
}

export function isIdempotencyKey(value) {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export class CalendarProviderError extends Error {
  constructor(kind, { operation = 'unknown', retryAfterMs = null } = {}) {
    if (!PROVIDER_ERROR_KINDS.has(kind)) throw new TypeError('CALENDAR_PROVIDER_ERROR_KIND_INVALID');
    if (typeof operation !== 'string' || operation.length < 1 || operation.length > 32) {
      throw new TypeError('CALENDAR_PROVIDER_OPERATION_INVALID');
    }
    if (
      retryAfterMs !== null
      && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > MAX_RETRY_AFTER_MS)
    ) {
      throw new TypeError('CALENDAR_PROVIDER_RETRY_AFTER_INVALID');
    }
    super(ERROR_CODE_BY_KIND[kind]);
    this.name = 'CalendarProviderError';
    this.kind = kind;
    this.operation = operation;
    this.retryable = RETRYABLE_ERROR_KINDS.has(kind);
    this.retryAfterMs = retryAfterMs;
  }
}

export function classifyProviderError(error, operation) {
  if (error instanceof CalendarProviderError) {
    return Object.freeze({
      code: ERROR_CODE_BY_KIND[error.kind],
      kind: error.kind,
      operation: error.operation,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    });
  }
  return Object.freeze({
    code: ERROR_CODE_BY_KIND[PROVIDER_ERROR_KIND.UNKNOWN],
    kind: PROVIDER_ERROR_KIND.UNKNOWN,
    operation,
    retryable: false,
    retryAfterMs: null,
  });
}

export function normalizeAvailabilityResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProviderResponse('availability');
  }
  if (typeof value.available !== 'boolean') throw invalidProviderResponse('availability');
  if (!Number.isSafeInteger(value.conflictCount) || value.conflictCount < 0 || value.conflictCount > MAX_CONFLICT_COUNT) {
    throw invalidProviderResponse('availability');
  }
  if (value.available && value.conflictCount !== 0) throw invalidProviderResponse('availability');
  return Object.freeze({
    available: value.available,
    conflictCount: value.conflictCount,
  });
}

export function normalizeReservationValidation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProviderResponse('reservation_validation');
  }
  if (typeof value.valid !== 'boolean') throw invalidProviderResponse('reservation_validation');
  if (!['available', 'conflict'].includes(value.reason)) throw invalidProviderResponse('reservation_validation');
  if (value.valid !== (value.reason === 'available')) throw invalidProviderResponse('reservation_validation');
  return Object.freeze({ valid: value.valid, reason: value.reason });
}

export function normalizeCreateResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidProviderResponse('create');
  if (!isProviderReference(value.providerReference)) throw invalidProviderResponse('create');
  if (!isProviderResourceReference(value.providerResourceReference)) throw invalidProviderResponse('create');
  if (!['created', 'existing'].includes(value.disposition)) throw invalidProviderResponse('create');
  return Object.freeze({
    providerReference: value.providerReference,
    providerResourceReference: value.providerResourceReference,
    disposition: value.disposition,
  });
}

export function normalizeUpdateResult(value, expectedProviderReference) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidProviderResponse('update');
  if (!isProviderReference(value.providerReference) || value.providerReference !== expectedProviderReference) {
    throw invalidProviderResponse('update');
  }
  if (!['updated', 'unchanged'].includes(value.disposition)) throw invalidProviderResponse('update');
  return Object.freeze({
    providerReference: value.providerReference,
    disposition: value.disposition,
  });
}

export function normalizeCancelResult(value, expectedProviderReference) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidProviderResponse('cancel');
  if (!isProviderReference(value.providerReference) || value.providerReference !== expectedProviderReference) {
    throw invalidProviderResponse('cancel');
  }
  if (!['cancelled', 'already_cancelled'].includes(value.disposition)) {
    throw invalidProviderResponse('cancel');
  }
  return Object.freeze({
    providerReference: value.providerReference,
    disposition: value.disposition,
  });
}

export function assertCalendarProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('CALENDAR_PROVIDER_REQUIRED');
  }
  if (!isInternalUuid(provider.integrationId)) throw new TypeError('CALENDAR_PROVIDER_INTEGRATION_ID_INVALID');
  if (!isProviderResourceReference(provider.providerResourceReference)) {
    throw new TypeError('CALENDAR_PROVIDER_RESOURCE_REFERENCE_INVALID');
  }
  if (!isProviderConnectionReference(provider.providerConnectionReference)) {
    throw new TypeError('CALENDAR_PROVIDER_CONNECTION_REFERENCE_INVALID');
  }
  for (const method of [
    'lookupAvailability',
    'validateReservation',
    'createCalendarEvent',
    'updateCalendarEvent',
    'cancelCalendarEvent',
  ]) {
    if (typeof provider[method] !== 'function') throw new TypeError(`CALENDAR_PROVIDER_METHOD_REQUIRED:${method}`);
  }
  return provider;
}
