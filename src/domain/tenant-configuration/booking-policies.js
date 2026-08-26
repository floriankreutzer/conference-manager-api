import {
  boundedInteger,
  exactObject,
  requireConfigurationSnapshot,
  TenantConfigurationInputError,
} from './protocol.js';

export const DEFAULT_BOOKING_POLICY_CONFIGURATION = Object.freeze({
  policy: Object.freeze({
    minimumLeadMinutes: 0,
    maximumAdvanceDays: 365,
    maximumDurationMinutes: 1_440,
    maximumParticipants: 100_000,
    approvalRequiredAboveParticipants: 25,
    cancellationDeadlineMinutes: 0,
  }),
});

export function normalizeBookingPolicyConfiguration(value) {
  exactObject(value, ['policy']);
  const policy = exactObject(value.policy, [
    'minimumLeadMinutes',
    'maximumAdvanceDays',
    'maximumDurationMinutes',
    'maximumParticipants',
    'approvalRequiredAboveParticipants',
    'cancellationDeadlineMinutes',
  ]);
  const normalized = {
    minimumLeadMinutes: boundedInteger(policy.minimumLeadMinutes, {
      minimum: 0,
      maximum: 525_600,
      code: 'TENANT_BOOKING_LEAD_TIME_INVALID',
    }),
    maximumAdvanceDays: boundedInteger(policy.maximumAdvanceDays, {
      minimum: 1,
      maximum: 1_825,
      code: 'TENANT_BOOKING_ADVANCE_WINDOW_INVALID',
    }),
    maximumDurationMinutes: boundedInteger(policy.maximumDurationMinutes, {
      minimum: 15,
      maximum: 10_080,
      code: 'TENANT_BOOKING_DURATION_INVALID',
    }),
    maximumParticipants: boundedInteger(policy.maximumParticipants, {
      minimum: 1,
      maximum: 100_000,
      code: 'TENANT_BOOKING_PARTICIPANTS_INVALID',
    }),
    approvalRequiredAboveParticipants: boundedInteger(
      policy.approvalRequiredAboveParticipants,
      {
        minimum: 0,
        maximum: 100_000,
        code: 'TENANT_BOOKING_APPROVAL_THRESHOLD_INVALID',
      },
    ),
    cancellationDeadlineMinutes: boundedInteger(policy.cancellationDeadlineMinutes, {
      minimum: 0,
      maximum: 525_600,
      code: 'TENANT_BOOKING_CANCELLATION_DEADLINE_INVALID',
    }),
  };
  if (normalized.approvalRequiredAboveParticipants > normalized.maximumParticipants) {
    throw new TenantConfigurationInputError('TENANT_BOOKING_APPROVAL_THRESHOLD_INVALID');
  }
  return requireConfigurationSnapshot({ policy: normalized });
}
