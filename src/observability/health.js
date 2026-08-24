const HEALTH_STATE = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
});

async function withTimeout(check, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('HEALTH_CHECK_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function evaluateChecks(checks, timeoutMs) {
  const settled = await Promise.allSettled(checks.map((check) => withTimeout(check, timeoutMs)));
  return settled.map((result) => result.status === 'fulfilled' && result.value === true);
}

export function createHealthMonitor({
  readinessChecks = [],
  degradationChecks = [],
  timeoutMs = 1_000,
  metrics,
} = {}) {
  if (!Array.isArray(readinessChecks) || readinessChecks.some((check) => typeof check !== 'function')) {
    throw new TypeError('READINESS_CHECKS_INVALID');
  }
  if (!Array.isArray(degradationChecks) || degradationChecks.some((check) => typeof check !== 'function')) {
    throw new TypeError('DEGRADATION_CHECKS_INVALID');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError('HEALTH_TIMEOUT_INVALID');
  }
  if (metrics && typeof metrics.recordDependencyState !== 'function') {
    throw new TypeError('HEALTH_METRICS_INVALID');
  }

  return Object.freeze({
    async evaluate() {
      const [required, optional] = await Promise.all([
        evaluateChecks(readinessChecks, timeoutMs),
        evaluateChecks(degradationChecks, timeoutMs),
      ]);
      const ready = required.every(Boolean);
      const degraded = ready && optional.some((result) => !result);

      for (const healthy of required) {
        metrics?.recordDependencyState({
          state: healthy ? HEALTH_STATE.HEALTHY : HEALTH_STATE.UNAVAILABLE,
          required: true,
        });
      }
      for (const healthy of optional) {
        metrics?.recordDependencyState({
          state: healthy ? HEALTH_STATE.HEALTHY : HEALTH_STATE.DEGRADED,
          required: false,
        });
      }

      return Object.freeze({
        status: ready ? (degraded ? 'degraded' : 'ready') : 'not_ready',
        ready,
        degraded,
      });
    },
  });
}
