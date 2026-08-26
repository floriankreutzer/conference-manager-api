import { isInternalUuid } from './identifiers.js';
import { isRequestId } from './request.js';

export const BOOKING_CHANGE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPLYING: 'applying',
  APPLIED: 'applied',
  REJECTED: 'rejected',
});

const STATUSES = new Set(Object.values(BOOKING_CHANGE_STATUS));

function utc(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

export function normalizeBookingChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('BOOKING_CHANGE_INVALID');
  }
  if (
    !isInternalUuid(value.tenantId)
    || !isInternalUuid(value.id)
    || !isInternalUuid(value.initiatorUserId)
    || !isRequestId(value.requestId)
    || !isRequestId(value.roomId)
    || !STATUSES.has(value.status)
    || !utc(value.startsAt)
    || !utc(value.endsAt)
    || Date.parse(value.endsAt) <= Date.parse(value.startsAt)
    || !Number.isSafeInteger(value.internalParticipants)
    || value.internalParticipants < 0
    || !Number.isSafeInteger(value.externalParticipants)
    || value.externalParticipants < 0
    || value.internalParticipants + value.externalParticipants < 1
    || !utc(value.baseRequestUpdatedAt)
    || !utc(value.createdAt)
    || !utc(value.updatedAt)
  ) throw new TypeError('BOOKING_CHANGE_INVALID');
  if (value.decidedByUserId !== null && !isInternalUuid(value.decidedByUserId)) {
    throw new TypeError('BOOKING_CHANGE_INVALID');
  }
  if (value.status === BOOKING_CHANGE_STATUS.APPLYING && value.decidedByUserId === null) {
    throw new TypeError('BOOKING_CHANGE_INVALID');
  }
  if ((value.status === BOOKING_CHANGE_STATUS.REJECTED) !== (value.rejectionReason !== null)) {
    throw new TypeError('BOOKING_CHANGE_INVALID');
  }
  return Object.freeze({ ...value });
}
