const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION_LIMIT = 128;
const REFERENCE_LIMIT = 500;
const TOTAL_REFERENCE_LIMIT = 2_000;
const MINUTES_PER_YEAR = 366 * 24 * 60;
const MAX_PARTICIPANTS = 100_000;

export const BOOKING_POLICY_OPERATION = Object.freeze({
  CREATE: 'create',
  RESUBMIT: 'resubmit',
  CHANGE: 'change',
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
});

const OPERATIONS = new Set(Object.values(BOOKING_POLICY_OPERATION));

export class TenantBookingPolicyInputError extends Error {
  constructor(code = 'TENANT_BOOKING_POLICIES_INVALID') {
    super(code);
    this.name = 'TenantBookingPolicyInputError';
    this.code = code;
  }
}

export class TenantBookingPolicyViolationError extends Error {
  constructor(code, parameters = {}) {
    super(code);
    this.name = 'TenantBookingPolicyViolationError';
    this.code = code;
    this.parameters = Object.freeze({ ...parameters });
  }
}

function inputError(code) {
  throw new TenantBookingPolicyInputError(code);
}

function exactObject(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    inputError('TENANT_BOOKING_POLICIES_INVALID');
  }
  const allowed = new Set(required);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    inputError('TENANT_BOOKING_POLICIES_INVALID');
  }
  return value;
}

function safeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) inputError(code);
  return value;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) inputError(code);
  return value;
}

function utcInstant(value, code) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) inputError(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) inputError(code);
  return value;
}

function referenceList(value, code) {
  if (!Array.isArray(value) || value.length > REFERENCE_LIMIT) inputError(code);
  const result = value.map((entry) => safeId(entry, code));
  if (new Set(result).size !== result.length) inputError(code);
  return Object.freeze([...result].sort());
}

function normalizeRules(value) {
  const rules = exactObject(value, [
    'minimumLeadTimeMinutes',
    'maximumAdvanceMinutes',
    'cancellationWindowMinutes',
    'changeWindowMinutes',
    'maximumParticipants',
    'allowedSiteIds',
    'allowedRoomIds',
    'allowedServiceIds',
  ]);
  const minimumLeadTimeMinutes = integer(
    rules.minimumLeadTimeMinutes,
    0,
    30 * 24 * 60,
    'TENANT_BOOKING_POLICY_LEAD_TIME_INVALID',
  );
  const maximumAdvanceMinutes = integer(
    rules.maximumAdvanceMinutes,
    1,
    2 * MINUTES_PER_YEAR,
    'TENANT_BOOKING_POLICY_ADVANCE_WINDOW_INVALID',
  );
  const cancellationWindowMinutes = integer(
    rules.cancellationWindowMinutes,
    0,
    30 * 24 * 60,
    'TENANT_BOOKING_POLICY_CANCELLATION_WINDOW_INVALID',
  );
  const changeWindowMinutes = integer(
    rules.changeWindowMinutes,
    0,
    30 * 24 * 60,
    'TENANT_BOOKING_POLICY_CHANGE_WINDOW_INVALID',
  );
  if (
    minimumLeadTimeMinutes > maximumAdvanceMinutes
    || cancellationWindowMinutes > maximumAdvanceMinutes
    || changeWindowMinutes > maximumAdvanceMinutes
  ) {
    inputError('TENANT_BOOKING_POLICY_WINDOW_ORDER_INVALID');
  }
  return Object.freeze({
    minimumLeadTimeMinutes,
    maximumAdvanceMinutes,
    cancellationWindowMinutes,
    changeWindowMinutes,
    maximumParticipants: integer(
      rules.maximumParticipants,
      1,
      MAX_PARTICIPANTS,
      'TENANT_BOOKING_POLICY_PARTICIPANT_LIMIT_INVALID',
    ),
    allowedSiteIds: referenceList(
      rules.allowedSiteIds,
      'TENANT_BOOKING_POLICY_SITE_REFERENCE_INVALID',
    ),
    allowedRoomIds: referenceList(
      rules.allowedRoomIds,
      'TENANT_BOOKING_POLICY_ROOM_REFERENCE_INVALID',
    ),
    allowedServiceIds: referenceList(
      rules.allowedServiceIds,
      'TENANT_BOOKING_POLICY_SERVICE_REFERENCE_INVALID',
    ),
  });
}

function normalizeVersion(value) {
  const version = exactObject(value, ['id', 'effectiveFrom', 'rules']);
  return Object.freeze({
    id: safeId(version.id, 'TENANT_BOOKING_POLICY_ID_INVALID'),
    effectiveFrom: utcInstant(
      version.effectiveFrom,
      'TENANT_BOOKING_POLICY_EFFECTIVE_FROM_INVALID',
    ),
    rules: normalizeRules(version.rules),
  });
}

export function normalizeTenantBookingPolicies(value) {
  const root = exactObject(value, ['versions']);
  if (
    !Array.isArray(root.versions)
    || root.versions.length < 1
    || root.versions.length > VERSION_LIMIT
  ) {
    inputError('TENANT_BOOKING_POLICY_VERSIONS_INVALID');
  }
  const versions = root.versions.map(normalizeVersion);
  if (new Set(versions.map((entry) => entry.id)).size !== versions.length) {
    inputError('TENANT_BOOKING_POLICY_ID_DUPLICATE');
  }
  if (new Set(versions.map((entry) => entry.effectiveFrom)).size !== versions.length) {
    inputError('TENANT_BOOKING_POLICY_EFFECTIVE_FROM_DUPLICATE');
  }
  for (const key of ['allowedSiteIds', 'allowedRoomIds', 'allowedServiceIds']) {
    if (
      new Set(versions.flatMap((entry) => entry.rules[key])).size
      > TOTAL_REFERENCE_LIMIT
    ) {
      inputError('TENANT_BOOKING_POLICY_REFERENCES_EXCESSIVE');
    }
  }
  versions.sort((left, right) => (
    Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom)
    || left.id.localeCompare(right.id)
  ));
  return Object.freeze({ versions: Object.freeze(versions) });
}

export const DEFAULT_TENANT_BOOKING_POLICIES = normalizeTenantBookingPolicies({
  versions: [{
    id: 'platform-default-v1',
    effectiveFrom: '1970-01-01T00:00:00.000Z',
    rules: {
      minimumLeadTimeMinutes: 0,
      maximumAdvanceMinutes: 527_040,
      cancellationWindowMinutes: 0,
      changeWindowMinutes: 0,
      maximumParticipants: MAX_PARTICIPANTS,
      allowedSiteIds: [],
      allowedRoomIds: [],
      allowedServiceIds: [],
    },
  }],
});

function requireDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) inputError(code);
  return value;
}

function sameVersion(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertTenantBookingPolicyTransition(currentValue, proposedValue, changedAt) {
  const current = normalizeTenantBookingPolicies(currentValue);
  const proposed = normalizeTenantBookingPolicies(proposedValue);
  const now = requireDate(changedAt, 'TENANT_BOOKING_POLICY_CHANGED_AT_INVALID').getTime();
  const proposedById = new Map(proposed.versions.map((entry) => [entry.id, entry]));
  for (const existing of current.versions) {
    if (Date.parse(existing.effectiveFrom) <= now) {
      const retained = proposedById.get(existing.id);
      if (!retained || !sameVersion(existing, retained)) {
        inputError('TENANT_BOOKING_POLICY_EFFECTIVE_VERSION_IMMUTABLE');
      }
    }
  }
  const currentIds = new Set(current.versions.map((entry) => entry.id));
  for (const candidate of proposed.versions) {
    if (!currentIds.has(candidate.id) && Date.parse(candidate.effectiveFrom) < now) {
      inputError('TENANT_BOOKING_POLICY_RETROACTIVE_VERSION_FORBIDDEN');
    }
  }
  if (!proposed.versions.some((entry) => Date.parse(entry.effectiveFrom) <= now)) {
    inputError('TENANT_BOOKING_POLICY_CURRENT_VERSION_REQUIRED');
  }
  return proposed;
}

export function selectEffectiveTenantBookingPolicy(value, evaluationInstant) {
  const configuration = normalizeTenantBookingPolicies(value);
  const instant = requireDate(
    evaluationInstant,
    'TENANT_BOOKING_POLICY_EVALUATION_INSTANT_INVALID',
  ).getTime();
  let selected = null;
  for (const candidate of configuration.versions) {
    if (Date.parse(candidate.effectiveFrom) > instant) break;
    selected = candidate;
  }
  if (!selected) inputError('TENANT_BOOKING_POLICY_CURRENT_VERSION_REQUIRED');
  return selected;
}

function policyContext(value) {
  const context = exactObject(value, [
    'operation',
    'evaluationInstant',
    'startsAt',
    'siteId',
    'roomId',
    'serviceIds',
    'participants',
  ]);
  if (!OPERATIONS.has(context.operation)) inputError('TENANT_BOOKING_POLICY_OPERATION_INVALID');
  const evaluationInstant = requireDate(
    context.evaluationInstant,
    'TENANT_BOOKING_POLICY_EVALUATION_INSTANT_INVALID',
  );
  const startsAt = requireDate(context.startsAt, 'TENANT_BOOKING_POLICY_START_INVALID');
  return Object.freeze({
    operation: context.operation,
    evaluationInstant,
    startsAt,
    siteId: safeId(context.siteId, 'TENANT_BOOKING_POLICY_SITE_REFERENCE_INVALID'),
    roomId: safeId(context.roomId, 'TENANT_BOOKING_POLICY_ROOM_REFERENCE_INVALID'),
    serviceIds: referenceList(
      context.serviceIds,
      'TENANT_BOOKING_POLICY_SERVICE_REFERENCE_INVALID',
    ),
    participants: integer(
      context.participants,
      0,
      MAX_PARTICIPANTS,
      'TENANT_BOOKING_POLICY_PARTICIPANTS_INVALID',
    ),
  });
}

function requireAllowed(allowlist, value, code) {
  if (allowlist.length > 0 && !allowlist.includes(value)) {
    throw new TenantBookingPolicyViolationError(code);
  }
}

function evaluateRules(version, context) {
  const millisecondsUntilStart = (
    context.startsAt.getTime() - context.evaluationInstant.getTime()
  );
  const { rules } = version;
  if (context.operation === BOOKING_POLICY_OPERATION.CANCEL) {
    if (millisecondsUntilStart < rules.cancellationWindowMinutes * 60_000) {
      throw new TenantBookingPolicyViolationError(
        'BOOKING_POLICY_CANCELLATION_WINDOW_VIOLATION',
        { requiredMinutes: rules.cancellationWindowMinutes },
      );
    }
  } else {
    if (millisecondsUntilStart < rules.minimumLeadTimeMinutes * 60_000) {
      throw new TenantBookingPolicyViolationError(
        'BOOKING_POLICY_LEAD_TIME_VIOLATION',
        { requiredMinutes: rules.minimumLeadTimeMinutes },
      );
    }
    if (millisecondsUntilStart > rules.maximumAdvanceMinutes * 60_000) {
      throw new TenantBookingPolicyViolationError(
        'BOOKING_POLICY_ADVANCE_WINDOW_VIOLATION',
        { maximumMinutes: rules.maximumAdvanceMinutes },
      );
    }
    if (
      context.operation === BOOKING_POLICY_OPERATION.CHANGE
      && millisecondsUntilStart < rules.changeWindowMinutes * 60_000
    ) {
      throw new TenantBookingPolicyViolationError(
        'BOOKING_POLICY_CHANGE_WINDOW_VIOLATION',
        { requiredMinutes: rules.changeWindowMinutes },
      );
    }
    if (context.participants > rules.maximumParticipants) {
      throw new TenantBookingPolicyViolationError(
        'BOOKING_POLICY_PARTICIPANT_LIMIT_VIOLATION',
        { maximumParticipants: rules.maximumParticipants },
      );
    }
    requireAllowed(
      rules.allowedSiteIds,
      context.siteId,
      'BOOKING_POLICY_SITE_NOT_ALLOWED',
    );
    requireAllowed(
      rules.allowedRoomIds,
      context.roomId,
      'BOOKING_POLICY_ROOM_NOT_ALLOWED',
    );
    for (const serviceId of context.serviceIds) {
      requireAllowed(
        rules.allowedServiceIds,
        serviceId,
        'BOOKING_POLICY_SERVICE_NOT_ALLOWED',
      );
    }
  }
}

export function normalizeTenantBookingPolicySnapshot(value) {
  const snapshot = exactObject(value, [
    'policyVersionId',
    'effectiveFrom',
    'evaluatedAt',
    'rules',
  ]);
  const normalized = Object.freeze({
    policyVersionId: safeId(
      snapshot.policyVersionId,
      'TENANT_BOOKING_POLICY_ID_INVALID',
    ),
    effectiveFrom: utcInstant(
      snapshot.effectiveFrom,
      'TENANT_BOOKING_POLICY_EFFECTIVE_FROM_INVALID',
    ),
    evaluatedAt: utcInstant(
      snapshot.evaluatedAt,
      'TENANT_BOOKING_POLICY_EVALUATED_AT_INVALID',
    ),
    rules: normalizeRules(snapshot.rules),
  });
  if (Date.parse(normalized.evaluatedAt) < Date.parse(normalized.effectiveFrom)) {
    inputError('TENANT_BOOKING_POLICY_SNAPSHOT_TIME_INVALID');
  }
  return normalized;
}

export function evaluateTenantBookingPolicy(configuration, value) {
  const context = policyContext(value);
  const version = selectEffectiveTenantBookingPolicy(
    configuration,
    context.evaluationInstant,
  );
  evaluateRules(version, context);
  return Object.freeze({
    policyVersionId: version.id,
    effectiveFrom: version.effectiveFrom,
    evaluatedAt: context.evaluationInstant.toISOString(),
    rules: version.rules,
  });
}

export function evaluateTenantBookingPolicySnapshot(snapshotValue, value) {
  const snapshot = normalizeTenantBookingPolicySnapshot(snapshotValue);
  const context = policyContext(value);
  evaluateRules({
    id: snapshot.policyVersionId,
    effectiveFrom: snapshot.effectiveFrom,
    rules: snapshot.rules,
  }, context);
  return Object.freeze({
    ...snapshot,
    enforcedAt: context.evaluationInstant.toISOString(),
  });
}
