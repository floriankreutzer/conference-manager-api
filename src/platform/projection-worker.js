const DEFAULT_INTERVAL_MS = 60_000;

export function createPlatformProjectionWorker({
  repository,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchLimit = 25,
  onError = () => {},
  onResult = () => {},
  runGate = (work) => work(),
  clock = Date.now,
  reconciliationIntervalMs = 900_000,
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
  if (typeof onResult !== 'function' || typeof clock !== 'function') {
    throw new TypeError('PLATFORM_PROJECTION_OBSERVER_REQUIRED');
  }
  if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs < 900_000) {
    throw new TypeError('PLATFORM_PROJECTION_RECONCILIATION_INTERVAL_INVALID');
  }
  if (typeof runGate !== 'function') throw new TypeError('PLATFORM_PROJECTION_RUN_GATE_REQUIRED');
  let timer = null;
  let active = null;
  let wakeTimer = null;
  let pendingWake = false;
  let unsubscribe = null;
  let subscribing = null;
  let stopped = false;
  let started = false;
  let lastReconciliation = null;

  function observe(result) {
    try { onResult(result); } catch { /* Telemetry cannot determine projection success. */ }
  }

  function report() {
    try { onError(new Error('PLATFORM_PROJECTION_WORK_UNAVAILABLE')); } catch { /* Non-authoritative observer. */ }
  }

  function wake() {
    if (stopped || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      if (active) { pendingWake = true; return; }
      runOnce().catch(report);
    }, 1000);
    wakeTimer.unref();
  }

  async function subscribe() {
    if (subscribing) return subscribing;
    if (stopped || unsubscribe || typeof repository.subscribe !== 'function') return;
    subscribing = Promise.resolve().then(async () => {
      try {
        const release = await repository.subscribe(wake, () => {
          unsubscribe = null;
          report();
        });
        if (stopped) await release();
        else {
          unsubscribe = release;
          // Inspect durable work after LISTEN, including commits in the startup gap.
          wake();
        }
      } catch { report(); }
      finally { subscribing = null; }
    });
    return subscribing;
  }

  async function runOnce() {
    if (active) return active;
    if (stopped) throw new TypeError('PLATFORM_PROJECTION_WORKER_STOPPED');
    active = Promise.resolve().then(async () => {
      if (started) await subscribe();
      return runGate(async () => {
        if (typeof repository.consumeBatch !== 'function') return repository.refreshBatch({ limit: batchLimit });
        const result = await repository.consumeBatch({ limit: batchLimit });
        observe(result);
        if (started && result.refreshedCount + result.retryCount + result.poisonCount === batchLimit) wake();
        const now = clock();
        if (!Number.isFinite(now)) throw new TypeError('PLATFORM_PROJECTION_CLOCK_INVALID');
        if (lastReconciliation === null || now - lastReconciliation >= reconciliationIntervalMs) {
          const reconciliation = await repository.refreshBatch({ limit: batchLimit });
          lastReconciliation = now;
          observe(Object.freeze({ reconciliationCount: reconciliation.refreshedCount }));
        }
        return result;
      });
    });
    try {
      return await active;
    } finally {
      active = null;
      if (pendingWake) { pendingWake = false; wake(); }
    }
  }

  return Object.freeze({
    runOnce,
    async start() {
      if (started) throw new TypeError('PLATFORM_PROJECTION_WORKER_ALREADY_STARTED');
      if (stopped) throw new TypeError('PLATFORM_PROJECTION_WORKER_STOPPED');
      started = true;
      await subscribe();
      if (stopped) return;
      timer = setInterval(() => {
        subscribe().catch(report);
        runOnce().catch(report);
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      if (subscribing) await subscribing.catch(() => {});
      if (unsubscribe) await unsubscribe();
      unsubscribe = null;
      if (active) await active;
    },
  });
}
