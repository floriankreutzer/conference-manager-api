import { isInternalUuid } from '../domain/identifiers.js';
import { isRequestId } from '../domain/request.js';
import {
  isIdempotencyKey,
  isProviderConnectionReference,
  isProviderReference,
  isProviderResourceReference,
} from './calendar-contract.js';

export const BOOKING_REFERENCE_STATE = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPENSATED: 'compensated',
  COMPENSATING: 'compensating',
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
    || !isProviderConnectionReference(value.providerConnectionReference)
    || !isProviderResourceReference(value.providerResourceReference)
    || !isIdempotencyKey(value.idempotencyKey)
    || !isInternalUuid(value.createdCorrelationId)
    || !Number.isSafeInteger(value.attemptNumber)
    || value.attemptNumber < 1
  ) {
    throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  }
  if (!BOOKING_REFERENCE_STATES.has(value.state)) throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  if (
    (value.state === BOOKING_REFERENCE_STATE.PENDING && value.providerReference !== null)
    || (value.state !== BOOKING_REFERENCE_STATE.PENDING && !isProviderReference(value.providerReference))
  ) {
    throw new TypeError('BOOKING_PROVIDER_REFERENCE_INVALID');
  }
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
    attemptNumber: value.attemptNumber,
    providerConnectionReference: value.providerConnectionReference,
    providerReference: value.providerReference,
    providerResourceReference: value.providerResourceReference,
    idempotencyKey: value.idempotencyKey,
    state: value.state,
    createdCorrelationId: value.createdCorrelationId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
