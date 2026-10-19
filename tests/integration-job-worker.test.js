import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrationJobWorker } from '../src/integrations/job-worker.js';

const result = () => ({ completedCount: 1, deferredCount: 2, reconciliationCount: 3, failedCount: 4 });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function timerHarness() {
  const events = []; let callback;
  return { events, tick() { callback?.(); }, port: {
    setInterval(work, interval) { callback = work; events.push(['scheduled', interval]); return { unref() { events.push(['unref']); } }; },
    clearInterval() { events.push(['cleared']); callback = null; },
  } };
}

test('awake worker resumes immediately, polls at the existing interval and serializes overlapping batches', async () => {
  const timers = timerHarness(); const observed = []; let release; let calls = 0;
  const worker = createIntegrationJobWorker({ timers: timers.port, onResult: (value) => observed.push(value), service: {
    async runBatch({ limit, signal }) {
      calls++; assert.equal(limit, 25); assert.equal(signal.aborted, false);
      await new Promise((resolve) => { release = resolve; }); return result();
    },
  } });
  worker.start(); await settle(); timers.tick(); timers.tick();
  const concurrent = worker.runOnce(); assert.equal(calls, 1);
  release(); assert.deepEqual(await concurrent, result()); assert.equal(observed.length, 1);
  assert.equal(Object.isFrozen(observed[0]), true);
  assert.deepEqual(timers.events, [['scheduled',60000],['unref']]);
  await worker.stop(); timers.tick(); assert.equal(calls, 1);
  assert.throws(() => worker.start(), /STOPPED/);
  await assert.rejects(worker.runOnce(), /STOPPED/);
});

test('shutdown aborts admission and awaits the active service before returning', async () => {
  let signal; let release; let stopped = false;
  const worker = createIntegrationJobWorker({ service: { async runBatch(input) {
    signal = input.signal; await new Promise((resolve) => { release = resolve; }); return result();
  } } });
  const active = worker.runOnce(); await settle();
  const stopping = worker.stop().then(() => { stopped = true; });
  assert.equal(signal.aborted, true); await settle(); assert.equal(stopped, false);
  release(); await active; await stopping; assert.equal(stopped, true);
  await worker.stop();
});

test('a pending readiness gate cannot admit work after shutdown', async () => {
  let open; let calls = 0;
  const worker = createIntegrationJobWorker({ service: { async runBatch() { calls++; return result(); } },
    async runGate(work) { await new Promise((resolve) => { open = resolve; }); return work(); },
  });
  const active = worker.runOnce(); const failure = assert.rejects(active, /BATCH_UNAVAILABLE/);
  await settle(); const stopping = worker.stop(); open(); await failure; await stopping;
  assert.equal(calls, 0);
});

test('poll failures are redacted, never retried inside a batch, and observers cannot change success', async () => {
  const timers = timerHarness(); const errors = []; let calls = 0;
  const worker = createIntegrationJobWorker({ timers: timers.port,
    onError(error) { errors.push(error.message); throw new Error('PRIVATE_OBSERVER'); },
    onResult() { throw new Error('PRIVATE_OBSERVER'); },
    service: { async runBatch() { calls++; if (calls === 1) throw new Error('PRIVATE_PROVIDER_TOKEN'); return result(); } },
  });
  worker.start(); await settle(); assert.equal(calls, 1);
  assert.deepEqual(errors, ['INTEGRATION_JOB_BATCH_UNAVAILABLE']);
  timers.tick(); await settle(); assert.equal(calls, 2);
  assert.deepEqual(await worker.runOnce(), result()); assert.equal(calls, 3);
  assert.throws(() => worker.start(), /ALREADY_STARTED/); await worker.stop();
});

test('closed bounded telemetry rejects identities, raw errors, sparse values, getters and invented counts', async () => {
  let getterReads = 0;
  const getter = Object.defineProperty(result(), 'completedCount', { enumerable: true, get() { getterReads++; return 1; } });
  for (const value of [null, [], {}, { ...result(), tenantId: 'PRIVATE_TENANT' }, { ...result(), completedCount: 26 },
    { ...result(), completedCount: -1 }, { ...result(), deferredCount: 1.5 },
    { completedCount: 25, deferredCount: 1, reconciliationCount: 0, failedCount: 0 }, getter]) {
    const observed = [];
    const worker = createIntegrationJobWorker({ onResult: (item) => observed.push(item), service: { async runBatch() { return value; } } });
    await assert.rejects(worker.runOnce(), /^Error: INTEGRATION_JOB_BATCH_UNAVAILABLE$/);
    assert.equal(observed.length, 0); await worker.stop();
  }
  assert.equal(getterReads, 0);
  for (const change of [{ intervalMs: 9999 }, { intervalMs: 900001 }, { batchLimit: 0 }, { batchLimit: 26 },
    { batchLimit: '25' }, { runGate: null }, { onError: null }, { timers: {} }]) {
    assert.throws(() => createIntegrationJobWorker({ service: { async runBatch() { return result(); } }, ...change }));
  }
});

test('a runtime gate cannot duplicate admission, replace outcomes or report work it did not execute', async () => {
  for (const runGate of [async () => result(), async (work) => { await work(); return result(); },
    async (work) => { const first = await work(); await work().catch(() => {}); return first; }]) {
    let calls = 0; let observations = 0;
    const worker = createIntegrationJobWorker({ runGate, onResult() { observations++; },
      service: { async runBatch() { calls++; return result(); } },
    });
    await assert.rejects(worker.runOnce(), /BATCH_UNAVAILABLE/);
    assert.equal(observations, 0); assert.ok(calls <= 1); await worker.stop();
  }
});
