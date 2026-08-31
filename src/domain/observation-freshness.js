function invalid() {
  const error = new TypeError('OBSERVATION_FRESHNESS_INVALID');
  error.code = error.message;
  throw error;
}

function requireTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

export function classifyObservationFreshness({ observedAtMs, freshUntilMs, asOfMs } = {}) {
  requireTime(asOfMs);
  if (observedAtMs === null || freshUntilMs === null) return 'unknown';
  const observed = requireTime(observedAtMs);
  const freshUntil = requireTime(freshUntilMs);
  if (freshUntil < observed) invalid();
  return freshUntil > asOfMs ? 'fresh' : 'stale';
}
