import { isInternalUuid } from './identifiers.js';
import { REQUEST_STATUS, isRequestStatus } from './request-workflow.js';

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_STATUSES = new Set([
  REQUEST_STATUS.REJECTED,
  REQUEST_STATUS.CHANGE_REQUESTED,
]);

function isUtcInstant(value) {
  return typeof value === 'string'
    && value.endsWith('Z')
    && Number.isFinite(Date.parse(value));
}

function isParticipantCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeReason(status, value) {
  if (REASON_STATUSES.has(status)) {
    if (
      typeof value !== 'string'
      || value.length < 1
      || value.length > 1000
      || value.trim() !== value
      || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new TypeError('REQUEST_RECORD_INVALID');
    }
    return value;
  }
  if (value !== null) throw new TypeError('REQUEST_RECORD_INVALID');
  return null;
}

export function isRequestId(value) {
  return typeof value === 'string' && BUSINESS_ID_PATTERN.test(value);
}

export function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('REQUEST_RECORD_INVALID');
  }
  if (!isInternalUuid(value.tenantId) || !isInternalUuid(value.requesterUserId) || !isRequestId(value.id)) {
    throw new TypeError('REQUEST_RECORD_INVALID');
  }
  if (value.roomId !== null && !isRequestId(value.roomId)) throw new TypeError('REQUEST_RECORD_INVALID');
  if (!isRequestStatus(value.status)) throw new TypeError('REQUEST_RECORD_INVALID');
  if (
    !isUtcInstant(value.startsAt)
    || !isUtcInstant(value.endsAt)
    || Date.parse(value.endsAt) <= Date.parse(value.startsAt)
  ) {
    throw new TypeError('REQUEST_RECORD_INVALID');
  }
  if (!isParticipantCount(value.internalParticipants) || !isParticipantCount(value.externalParticipants)) {
    throw new TypeError('REQUEST_RECORD_INVALID');
  }
  for (const timestamp of [value.statusChangedAt, value.createdAt, value.updatedAt]) {
    if (!isUtcInstant(timestamp)) throw new TypeError('REQUEST_RECORD_INVALID');
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new TypeError('REQUEST_RECORD_INVALID');

  return Object.freeze({
    tenantId: value.tenantId,
    id: value.id,
    requesterUserId: value.requesterUserId,
    roomId: value.roomId,
    status: value.status,
    statusReason: normalizeReason(value.status, value.statusReason),
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    internalParticipants: value.internalParticipants,
    externalParticipants: value.externalParticipants,
    statusChangedAt: value.statusChangedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
