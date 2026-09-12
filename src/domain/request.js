import { isInternalUuid } from './identifiers.js';
import {
  REQUEST_MAX_PARTICIPANTS,
  isSupportedRequestCompositionSchemaVersion,
  normalizePersistedRequestCompositionSnapshot,
} from './request-composition.js';
import { REQUEST_STATUS, isRequestStatus } from './request-workflow.js';

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASON_STATUSES = new Set([
  REQUEST_STATUS.REJECTED,
  REQUEST_STATUS.CHANGE_REQUESTED,
]);

function isUtcInstant(value) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isParticipantCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
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

function policyAllows(values, selected) {
  return values.length === 0 || values.includes(selected);
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
  const schemaVersion = value.schemaVersion ?? 1;
  const version = value.version ?? 1;
  if (
    (schemaVersion !== 1 && !isSupportedRequestCompositionSchemaVersion(schemaVersion))
    || !positiveVersion(version)
  ) {
    throw new TypeError('REQUEST_RECORD_INVALID');
  }
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

  let snapshot = null;
  if (isSupportedRequestCompositionSchemaVersion(schemaVersion)) {
    try {
      snapshot = normalizePersistedRequestCompositionSnapshot(value.snapshot, version);
    } catch {
      throw new TypeError('REQUEST_RECORD_INVALID');
    }
    const totalParticipants = value.internalParticipants + value.externalParticipants;
    const rules = snapshot.policy.rules;
    if (
      snapshot.schemaVersion !== schemaVersion
      || snapshot.pricing.room.id !== value.roomId
      || totalParticipants < 1
      || totalParticipants > REQUEST_MAX_PARTICIPANTS
      || Date.parse(value.endsAt) - Date.parse(value.startsAt) > 24 * 60 * 60 * 1_000
      || snapshot.details.catering.participantCount > totalParticipants
      || totalParticipants > rules.maximumParticipants
      || !policyAllows(rules.allowedSiteIds, snapshot.pricing.room.siteId)
      || !policyAllows(rules.allowedRoomIds, value.roomId)
      || snapshot.details.serviceIds.some((id) => !policyAllows(rules.allowedServiceIds, id))
    ) throw new TypeError('REQUEST_RECORD_INVALID');
  } else if (value.snapshot !== null && value.snapshot !== undefined) {
    throw new TypeError('REQUEST_RECORD_INVALID');
  }

  return Object.freeze({
    tenantId: value.tenantId,
    id: value.id,
    requesterUserId: value.requesterUserId,
    schemaVersion,
    version,
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
    snapshot,
  });
}

export function toPublicRequest(value) {
  const request = normalizeRequest(value);
  const common = {
    schemaVersion: request.schemaVersion,
    version: request.version,
    id: request.id,
    roomId: request.roomId,
    status: request.status,
    statusReason: request.statusReason,
    startsAt: request.startsAt,
    endsAt: request.endsAt,
    internalParticipants: request.internalParticipants,
    externalParticipants: request.externalParticipants,
    statusChangedAt: request.statusChangedAt,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
  if (request.schemaVersion === 1) {
    return Object.freeze({
      ...common,
      details: null,
      pricing: null,
      configurationRevisions: null,
      policy: null,
      allocations: null,
    });
  }
  return Object.freeze({
    ...common,
    details: request.snapshot.details,
    pricing: request.snapshot.pricing,
    configurationRevisions: request.snapshot.configurationRevisions,
    policy: request.snapshot.policy,
    allocations: request.snapshot.allocations,
  });
}

export function normalizePublicRequest(value, { tenantId, requesterUserId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('REQUEST_PUBLIC_RECORD_INVALID');
  }
  const keys = [
    'schemaVersion',
    'version',
    'id',
    'roomId',
    'status',
    'statusReason',
    'startsAt',
    'endsAt',
    'internalParticipants',
    'externalParticipants',
    'statusChangedAt',
    'createdAt',
    'updatedAt',
    'details',
    'pricing',
    'configurationRevisions',
    'policy',
    'allocations',
  ];
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new TypeError('REQUEST_PUBLIC_RECORD_INVALID');
  let snapshot = null;
  if (isSupportedRequestCompositionSchemaVersion(value.schemaVersion)) {
    const capturedAt = value.allocations?.snapshottedAt;
    snapshot = {
      schemaVersion: value.schemaVersion,
      requestVersion: value.version,
      capturedAt,
      configurationRevisions: value.configurationRevisions,
      details: value.details,
      pricing: value.pricing,
      policy: value.policy,
      allocations: value.allocations,
    };
  } else if (
    value.schemaVersion !== 1
    || value.details !== null
    || value.pricing !== null
    || value.configurationRevisions !== null
    || value.policy !== null
    || value.allocations !== null
  ) {
    throw new TypeError('REQUEST_PUBLIC_RECORD_INVALID');
  }
  try {
    return toPublicRequest(normalizeRequest({
      tenantId,
      requesterUserId,
      id: value.id,
      schemaVersion: value.schemaVersion,
      version: value.version,
      roomId: value.roomId,
      status: value.status,
      statusReason: value.statusReason,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      internalParticipants: value.internalParticipants,
      externalParticipants: value.externalParticipants,
      statusChangedAt: value.statusChangedAt,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      snapshot,
    }));
  } catch {
    throw new TypeError('REQUEST_PUBLIC_RECORD_INVALID');
  }
}
