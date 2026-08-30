const DEFAULT_INTERVAL_MS = 60_000;

export function createPlatformProjectionWorker({
  repository,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchLimit = 25,
  onError = () => {},
  runGate = (work) => work(),
} = {}) {
  if (!repository || typeof repository.refreshBatch !== 'function') {
    throw new TypeError('PLATFORM_PROJECTION_REPOSITORY_REQUIRED');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 900_000) {
    throw new TypeError('PLATFORM_PROJECTION_INTERVAL_INVALID');
  }
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) {
    throw new TypeError('PLATFORM_PROJECTION_BATCH_LIMIT_INVALID');
  }
  if (typeof onError !== 'function') throw new TypeError('PLATFORM_PROJECTION_ERROR_HANDLER_REQUIRED');
  if (typeof runGate !== 'function') throw new TypeError('PLATFORM_PROJECTION_RUN_GATE_REQUIRED');
  let timer = null;
  let active = null;

  async function runOnce() {
    if (active) return active;
    active = Promise.resolve().then(() => runGate(
      () => repository.refreshBatch({ limit: batchLimit }),
    ));
    try {
      return await active;
    } finally {
      active = null;
    }
  }

  return Object.freeze({
    runOnce,
    start() {
      if (timer) throw new TypeError('PLATFORM_PROJECTION_WORKER_ALREADY_STARTED');
      timer = setInterval(() => runOnce().catch(onError), intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (active) await active;
    },
  });
}
