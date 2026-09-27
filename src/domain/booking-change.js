import { isInternalUuid } from './identifiers.js';
import { normalizeActionAttribution } from './request-attribution.js';
import {
  assertRequestDraftSnapshotConsistency,
  isSupportedRequestCompositionSchemaVersion,
  normalizePersistedRequestCompositionSnapshot,
  normalizeRequestCompositionDraft,
} from './request-composition.js';
import { isRequestId } from './request.js';

export const BOOKING_CHANGE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPLYING: 'applying',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
});

const STATUSES = new Set(Object.values(BOOKING_CHANGE_STATUS));
export const BOOKING_CHANGE_RECOVERY_PHASE = Object.freeze({
  NONE: 'none',
  MOVE_PENDING: 'move_pending',
  TARGET_ACTIVE: 'target_active',
  RESTORE_PENDING: 'restore_pending',
  RECONCILIATION_REQUIRED: 'reconciliation_required',
});
const RECOVERY_PHASES = new Set(Object.values(BOOKING_CHANGE_RECOVERY_PHASE));
const PROVIDER_REFERENCE = /^[^\u0000-\u001f\u007f]{1,255}$/;
const PROVIDER_RESOURCE_REFERENCE = /^[^\u0000-\u001f\u007f]{3,320}$/;
const IDEMPOTENCY_KEY = /^[0-9a-f]{64}$/;

function utc(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

export function normalizeBookingChangeCalendarReplacement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('BOOKING_CHANGE_CALENDAR_REPLACEMENT_INVALID');
  }
  const keys = [
    'idempotencyKey',
    'integrationId',
    'previousProviderReference',
    'previousProviderResourceReference',
    'providerReference',
    'providerResourceReference',
  ];
  const actual = Object.keys(value).sort();
  if (
    actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])
    || !isInternalUuid(value.integrationId)
    || typeof value.previousProviderReference !== 'string'
    || value.previousProviderReference.trim() !== value.previousProviderReference
    || !PROVIDER_REFERENCE.test(value.previousProviderReference)
    || typeof value.previousProviderResourceReference !== 'string'
    || value.previousProviderResourceReference.trim() !== value.previousProviderResourceReference
    || !PROVIDER_RESOURCE_REFERENCE.test(value.previousProviderResourceReference)
    || typeof value.providerReference !== 'string'
    || value.providerReference.trim() !== value.providerReference
    || !PROVIDER_REFERENCE.test(value.providerReference)
    || typeof value.providerResourceReference !== 'string'
    || value.providerResourceReference.trim() !== value.providerResourceReference
    || !PROVIDER_RESOURCE_REFERENCE.test(value.providerResourceReference)
    || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
  ) throw new TypeError('BOOKING_CHANGE_CALENDAR_REPLACEMENT_INVALID');
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
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
  if (
    [BOOKING_CHANGE_STATUS.APPLYING, BOOKING_CHANGE_STATUS.SUPERSEDED].includes(value.status)
    && value.decidedByUserId === null
  ) {
    throw new TypeError('BOOKING_CHANGE_INVALID');
  }
  if ((value.status === BOOKING_CHANGE_STATUS.REJECTED) !== (value.rejectionReason !== null)) {
    throw new TypeError('BOOKING_CHANGE_INVALID');
  }
  const requestSchemaVersion = value.requestSchemaVersion ?? 1;
  const baseRequestVersion = value.baseRequestVersion ?? 1;
  if (
    (requestSchemaVersion !== 1
      && !isSupportedRequestCompositionSchemaVersion(requestSchemaVersion))
    || !Number.isSafeInteger(baseRequestVersion)
    || baseRequestVersion < 1
  ) throw new TypeError('BOOKING_CHANGE_INVALID');
  const moveAttemptNumber = value.moveAttemptNumber ?? 0;
  const recoveryPhase = value.recoveryPhase ?? BOOKING_CHANGE_RECOVERY_PHASE.NONE;
  if (
    !Number.isSafeInteger(moveAttemptNumber)
    || moveAttemptNumber < 0
    || moveAttemptNumber > 2_147_483_647
    || !RECOVERY_PHASES.has(recoveryPhase)
  ) throw new TypeError('BOOKING_CHANGE_INVALID');
  let calendarReplacement = null;
  if (value.calendarReplacement !== null && value.calendarReplacement !== undefined) {
    try {
      calendarReplacement = normalizeBookingChangeCalendarReplacement(value.calendarReplacement);
    } catch {
      throw new TypeError('BOOKING_CHANGE_INVALID');
    }
  }
  if (
    value.status !== BOOKING_CHANGE_STATUS.APPLYING
    && (recoveryPhase !== BOOKING_CHANGE_RECOVERY_PHASE.NONE || calendarReplacement !== null)
  ) throw new TypeError('BOOKING_CHANGE_INVALID');
  if (
    recoveryPhase === BOOKING_CHANGE_RECOVERY_PHASE.MOVE_PENDING
    && calendarReplacement !== null
  ) throw new TypeError('BOOKING_CHANGE_INVALID');
  if (
    [
      BOOKING_CHANGE_RECOVERY_PHASE.TARGET_ACTIVE,
      BOOKING_CHANGE_RECOVERY_PHASE.RESTORE_PENDING,
    ].includes(recoveryPhase)
    && calendarReplacement === null
  ) throw new TypeError('BOOKING_CHANGE_INVALID');
  let requestDraft = null;
  let proposedRequestSnapshot = null;
  if (isSupportedRequestCompositionSchemaVersion(requestSchemaVersion)) {
    try {
      requestDraft = normalizeRequestCompositionDraft(value.requestDraft, requestSchemaVersion);
      proposedRequestSnapshot = normalizePersistedRequestCompositionSnapshot(
        value.proposedRequestSnapshot,
        baseRequestVersion + 1,
      );
      assertRequestDraftSnapshotConsistency(
        requestDraft,
        proposedRequestSnapshot,
        requestSchemaVersion,
      );
      if (
        value.roomId !== requestDraft.roomId
        || value.startsAt !== requestDraft.startsAt
        || value.endsAt !== requestDraft.endsAt
        || value.internalParticipants !== requestDraft.internalParticipants
        || value.externalParticipants !== requestDraft.externalParticipants
      ) throw new TypeError('BOOKING_CHANGE_INVALID');
    } catch {
      throw new TypeError('BOOKING_CHANGE_INVALID');
    }
  } else if (
    (value.requestDraft !== null && value.requestDraft !== undefined)
    || (value.proposedRequestSnapshot !== null && value.proposedRequestSnapshot !== undefined)
  ) {
    throw new TypeError('BOOKING_CHANGE_INVALID');
  }
  if (value.decidedByUserId === null && value.deciderAttribution !== null) {
    throw new TypeError('BOOKING_CHANGE_ATTRIBUTION_INVALID');
  }
  return Object.freeze({
    ...value,
    initiatorAttribution: normalizeActionAttribution(
      value.initiatorAttribution,
    ),
    deciderAttribution: value.decidedByUserId === null
      ? null
      : normalizeActionAttribution(value.deciderAttribution),
    requestSchemaVersion,
    baseRequestVersion,
    moveAttemptNumber,
    recoveryPhase,
    calendarReplacement,
    requestDraft,
    proposedRequestSnapshot,
  });
}
