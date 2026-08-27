export class TenantBookingPolicyInputError extends Error {
  constructor(code = 'TENANT_BOOKING_POLICY_INVALID') {
    super(code);
    this.name = 'TenantBookingPolicyInputError';
    this.code = code;
  }
}
function invalid() { throw new TenantBookingPolicyInputError(); }
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
export function normalizeTenantBookingPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const keys = [
    'minNoticeMinutes', 'maxAdvanceDays', 'maxDurationMinutes', 'maxParticipants',
    'allowExternalParticipants', 'cancellationCutoffMinutes', 'changeCutoffMinutes',
  ];
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  if (typeof value.allowExternalParticipants !== 'boolean') invalid();
  return Object.freeze({
    minNoticeMinutes: integer(value.minNoticeMinutes, 0, 525600),
    maxAdvanceDays: integer(value.maxAdvanceDays, 1, 730),
    maxDurationMinutes: integer(value.maxDurationMinutes, 15, 10080),
    maxParticipants: integer(value.maxParticipants, 1, 100000),
    allowExternalParticipants: value.allowExternalParticipants,
    cancellationCutoffMinutes: integer(value.cancellationCutoffMinutes, 0, 10080),
    changeCutoffMinutes: integer(value.changeCutoffMinutes, 0, 10080),
  });
}

export function assertRequestAgainstBookingPolicy(policy, {
  startsAt,
  endsAt,
  internalParticipants,
  externalParticipants,
}, now = Date.now()) {
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
  const end = endsAt instanceof Date ? endsAt : new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) invalid();
  const noticeMinutes = (start.getTime() - now) / 60000;
  const advanceDays = noticeMinutes / 1440;
  const durationMinutes = (end.getTime() - start.getTime()) / 60000;
  const totalParticipants = internalParticipants + externalParticipants;
  if (noticeMinutes < policy.minNoticeMinutes
      || advanceDays > policy.maxAdvanceDays
      || durationMinutes > policy.maxDurationMinutes
      || totalParticipants > policy.maxParticipants
      || (!policy.allowExternalParticipants && externalParticipants > 0)) {
    throw new TenantBookingPolicyInputError('BOOKING_POLICY_VIOLATION');
  }
  return true;
}
