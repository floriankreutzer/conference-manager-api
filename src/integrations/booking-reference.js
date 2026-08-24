import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import { isIdempotencyKey, isProviderReference } from './calendar-contract.js';

export const BOOKING_REFERENCE_STATE = Object.freeze({
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
});

const BOOKING_REFERENCE_STATES = new Set(Object.values(BOOKING_REFERENCE_STATE));

function isUtcInstant(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

export function normalizeBookingProviderReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  }
  if (
    !isInternalUuid(value.tenantId)
    || !isRequestId(value.requestId)
    || !isInternalUuid(value.integrationId)
    || !isProviderReference(value.providerReference)
    || !isIdempotencyKey(value.idempotencyKey)
    || !isInternalUuid(value.createdCorrelationId)
  ) {
    throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  }
  if (!BOOKING_REFERENCE_STATES.has(value.state)) throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  if (!isUtcInstant(value.createdAt) || !isUtcInstant(value.updatedAt)) {
    throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  }
  return Object.freeze({
    tenantId: value.tenantId,
    requestId: value.requestId,
    integrationId: value.integrationId,
    providerReference: value.providerReference,
    idempotencyKey: value.idempotencyKey,
    state: value.state,
    createdCorrelationId: value.createdCorrelationId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
