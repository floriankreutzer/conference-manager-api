const COUNTERS = ['completedCount','deferredCount','reconciliationCount','failedCount'];

function batchResult(value, limit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('INTEGRATION_JOB_BATCH_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== COUNTERS.length || keys.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !COUNTERS.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')
      || !Number.isSafeInteger(property.value) || property.value < 0 || property.value > limit;
  })) throw new TypeError('INTEGRATION_JOB_BATCH_INVALID');
  if (COUNTERS.reduce((sum, key) => sum + value[key], 0) > limit) throw new TypeError('INTEGRATION_JOB_BATCH_INVALID');
  return Object.freeze(Object.fromEntries(COUNTERS.map((key) => [key, value[key]])));
}

// Process lifecycle only. The injected service must claim durable scoped leases,
// persist dispatch intent and fence outcome/audit transactions. Polling itself
// establishes neither durability nor provider delivery or a delivery deadline.
export function createIntegrationJobWorker({
  service,
  intervalMs = 60000,
  batchLimit = 25,
  runGate = (work) => work(),
  onResult = () => {},
  onError = () => {},
  timers = globalThis,
} = {}) {
  if (!service || typeof service.runBatch !== 'function') throw new TypeError('INTEGRATION_JOB_SERVICE_REQUIRED');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10000 || intervalMs > 900000) {
    throw new TypeError('INTEGRATION_JOB_INTERVAL_INVALID');
  }
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 25) throw new TypeError('INTEGRATION_JOB_LIMIT_INVALID');
  if (![runGate, onResult, onError, timers?.setInterval, timers?.clearInterval].every((value) => typeof value === 'function')) {
    throw new TypeError('INTEGRATION_JOB_LIFECYCLE_PORT_REQUIRED');
  }
  let started = false;
  let stopped = false;
  let timer = null;
  let active = null;
  const controller = new AbortController();
  function report() {
    try { onError(new Error('INTEGRATION_JOB_BATCH_UNAVAILABLE')); } catch { /* Non-authoritative observer. */ }
  }
  function runOnce() {
    if (stopped) return Promise.reject(new TypeError('INTEGRATION_JOB_WORKER_STOPPED'));
    if (active) return active;
    let executions = 0;
    let serviceResult = null;
    active = Promise.resolve().then(() => runGate(async () => {
      if (++executions !== 1 || stopped) throw new TypeError('INTEGRATION_JOB_ADMISSION_INVALID');
      serviceResult = batchResult(await service.runBatch({ limit: batchLimit, signal: controller.signal }), batchLimit);
      return serviceResult;
    })).then((result) => {
      // A gate must return the actual bounded result; it cannot invent a success.
      if (executions !== 1 || result !== serviceResult) throw new TypeError('INTEGRATION_JOB_ADMISSION_INVALID');
      try { onResult(serviceResult); } catch { /* Telemetry cannot decide committed job outcomes. */ }
      return serviceResult;
    }).catch(() => {
      throw new Error('INTEGRATION_JOB_BATCH_UNAVAILABLE');
    }).finally(() => { active = null; });
    return active;
  }
  return Object.freeze({
    runOnce,
    start() {
      if (stopped) throw new TypeError('INTEGRATION_JOB_WORKER_STOPPED');
      if (started) throw new TypeError('INTEGRATION_JOB_WORKER_ALREADY_STARTED');
      started = true;
      timer = timers.setInterval(() => { void runOnce().catch(report); }, intervalMs);
      timer?.unref?.();
      void runOnce().catch(report);
    },
    async stop() {
      stopped = true;
      controller.abort();
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
      // Cancellation signals the service; await it rather than closing its pool
      // while dispatch/reconciliation/result persistence is still in flight.
      if (active) await active.catch(() => {});
    },
  });
}
