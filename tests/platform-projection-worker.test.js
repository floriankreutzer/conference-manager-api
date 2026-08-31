import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformProjectionWorker } from '../src/platform/projection-worker.js';

test('projection worker serializes overlapping refreshes and uses the bounded batch', async () => {
  let releases;
  let calls = 0;
  const repository = {
    async refreshBatch(values) {
      calls += 1;
      assert.deepEqual(values, { limit: 7 });
      await new Promise((resolve) => { releases = resolve; });
      return { refreshedCount: 1 };
    },
  };
  const worker = createPlatformProjectionWorker({ repository, intervalMs: 10_000, batchLimit: 7 });
  const first = worker.runOnce();
  const second = worker.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releases();
  assert.deepEqual(await first, { refreshedCount: 1 });
  assert.deepEqual(await second, { refreshedCount: 1 });
  await worker.stop();
});

test('projection worker exposes refresh failures and remains retryable', async () => {
  let calls = 0;
  const worker = createPlatformProjectionWorker({
    repository: {
      async refreshBatch() {
        calls += 1;
        if (calls === 1) throw new Error('dependency unavailable');
        return { refreshedCount: 0 };
      },
    },
  });
  await assert.rejects(worker.runOnce(), /dependency unavailable/);
  assert.deepEqual(await worker.runOnce(), { refreshedCount: 0 });
});

test('projection worker executes every refresh inside the injected runtime gate', async () => {
  const events = [];
  const worker = createPlatformProjectionWorker({
    repository: {
      async refreshBatch() {
        events.push('refresh');
        return { refreshedCount: 2 };
      },
    },
    async runGate(work) {
      events.push('gate:start');
      const result = await work();
      events.push('gate:end');
      return result;
    },
  });
  assert.deepEqual(await worker.runOnce(), { refreshedCount: 2 });
  assert.deepEqual(events, ['gate:start', 'refresh', 'gate:end']);
});
