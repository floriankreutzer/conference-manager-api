const OPERATIONS = Object.freeze([
  'session_read', 'room_page_read', 'availability_lookup', 'request_create',
  'request_read', 'request_transition', 'media_read',
]);

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error('WORKLOAD_PLAN_INVALID');
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('WORKLOAD_PLAN_INVALID');
}

// Planning arithmetic only: no network, runtime configuration, billing or capacity authority.
export function planBookingWorkload(input) {
  exactObject(input, ['schemaVersion', 'monthlyBookings', 'peakActiveUsers', 'operationsPerBooking', 'requestCadencesSeconds']);
  if (input.schemaVersion !== 1) throw new Error('WORKLOAD_PLAN_INVALID');
  integer(input.monthlyBookings, 1, 1_000_000_000);
  integer(input.peakActiveUsers, 1, 1_000_000);
  exactObject(input.operationsPerBooking, OPERATIONS);
  const monthlyOperations = {};
  let operationsPerBooking = 0;
  for (const operation of OPERATIONS) {
    const count = input.operationsPerBooking[operation];
    integer(count, 0, 1_000);
    operationsPerBooking += count;
    monthlyOperations[operation] = input.monthlyBookings * count;
  }
  if (operationsPerBooking === 0) throw new Error('WORKLOAD_PLAN_INVALID');
  const cadences = input.requestCadencesSeconds;
  if (!Array.isArray(cadences) || cadences.length < 1 || cadences.length > 10
    || new Set(cadences).size !== cadences.length) throw new Error('WORKLOAD_PLAN_INVALID');
  for (const seconds of cadences) integer(seconds, 1, 86_400);
  return {
    schemaVersion: 1,
    evidenceKind: 'planning_only',
    capacityAccepted: false,
    activityMixApproved: false,
    monthlyBookings: input.monthlyBookings,
    peakActiveUsers: input.peakActiveUsers,
    monthlyOperations,
    monthlyBookingRelatedOperations: input.monthlyBookings * operationsPerBooking,
    peakRequestSensitivity: cadences.map(seconds => ({
      secondsBetweenRequestsPerActiveUser: seconds,
      aggregateRequestsPerSecond: input.peakActiveUsers / seconds,
    })),
    providerCosts: 'unknown',
    backgroundAndNonBookingTraffic: 'unknown',
    simultaneousInFlightRequests: 'unknown',
  };
}
