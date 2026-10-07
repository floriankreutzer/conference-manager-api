import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { createPlatformProjectionWorker } from '../src/platform/projection-worker.js';
import { createPostgresPlatformProjectionRepository } from '../src/persistence/postgres/platform-projection-repository.js';
import { subscribePlatformProjectionNotifications } from '../src/persistence/postgres/platform-projection-notifications.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';

test('durable outbox dispatch is independent of wakeups and reconciliation is slow and bounded', async () => {
  let now = 0;
  let consumed = 0;
  let reconciled = 0;
  const observed = [];
  const worker = createPlatformProjectionWorker({ clock: () => now, batchLimit: 7,
    repository: {
      async consumeBatch(input) {
        assert.deepEqual(input, { limit: 7 }); consumed += 1;
        return { refreshedCount: 1, retryCount: 0, poisonCount: 0 };
      },
      async refreshBatch(input) {
        assert.deepEqual(input, { limit: 7 }); reconciled += 1; return { refreshedCount: 3 };
      },
    },
    onResult: (result) => observed.push(result),
  });
  await worker.runOnce();
  now = 60_000; await worker.runOnce();
  now = 899_999; await worker.runOnce();
  assert.equal(reconciled, 1); assert.equal(consumed, 3);
  now = 900_000; await worker.runOnce();
  assert.equal(reconciled, 2); assert.equal(consumed, 4);
  assert.equal(observed.filter((result) => result.reconciliationCount === 3).length, 2);
  await worker.stop();
});

test('empty commit notifications coalesce and stopping releases the one subscription', async (t) => {
  let wake;
  let consumed = 0;
  let released = 0;
  const worker = createPlatformProjectionWorker({ repository: {
    async subscribe(callback) { wake = callback; return async () => { released += 1; }; },
    async consumeBatch() { consumed += 1; return { refreshedCount: 0, retryCount: 0, poisonCount: 0 }; },
    async refreshBatch() { return { refreshedCount: 0 }; },
  } });
  t.after(() => worker.stop());
  await worker.start();
  for (let index = 0; index < 100; index += 1) wake();
  await wait(1100);
  assert.equal(consumed, 1);
  await assert.rejects(worker.start(), /ALREADY_STARTED/);
  await worker.stop();
  wake(); await wait(20);
  assert.equal(consumed, 1); assert.equal(released, 1);
});

test('subscription reconnects after failure and never exposes driver error details', async () => {
  let attempts = 0;
  const errors = [];
  const worker = createPlatformProjectionWorker({ repository: {
    async subscribe() { attempts += 1; throw new Error('private credential driver details'); },
    async consumeBatch() { return { refreshedCount: 0, retryCount: 0, poisonCount: 0 }; },
    async refreshBatch() { return { refreshedCount: 0 }; },
  }, onError: (error) => errors.push(error.message) });
  await worker.start();
  assert.equal(attempts, 1);
  assert.deepEqual(errors, ['PLATFORM_PROJECTION_WORK_UNAVAILABLE']);
  assert.deepEqual(await worker.runOnce(), { refreshedCount: 0, retryCount: 0, poisonCount: 0 });
  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['PLATFORM_PROJECTION_WORK_UNAVAILABLE', 'PLATFORM_PROJECTION_WORK_UNAVAILABLE']);
  await worker.stop();
});

test('shutdown waits for a subscription acquired during startup and its asynchronous release', async () => {
  let connected;
  let released;
  let releaseStarted = false;
  let stopped = false;
  const connection = new Promise((resolve) => { connected = resolve; });
  const release = new Promise((resolve) => { released = resolve; });
  const worker = createPlatformProjectionWorker({ repository: {
    async subscribe() { await connection; return async () => { releaseStarted = true; await release; }; },
    async consumeBatch() { assert.fail('stopped worker must not dispatch'); },
    async refreshBatch() { assert.fail('stopped worker must not reconcile'); },
  } });
  const starting = worker.start();
  await wait(0);
  const stopping = worker.stop().then(() => { stopped = true; });
  connected();
  await wait(0);
  assert.equal(releaseStarted, true);
  assert.equal(stopped, false);
  released();
  await Promise.all([starting, stopping]);
  assert.equal(stopped, true);
});

test('successful LISTEN checks durable work even without a notification in the startup gap', async () => {
  let consumed = 0;
  const worker = createPlatformProjectionWorker({ repository: {
    async subscribe() { return async () => {}; },
    async consumeBatch() { consumed += 1; return { refreshedCount: 1, retryCount: 0, poisonCount: 0 }; },
    async refreshBatch() { return { refreshedCount: 0 }; },
  } });
  try {
    await worker.start();
    await wait(1100);
    assert.equal(consumed, 1);
  } finally { await worker.stop(); }
});

test('listener accepts only the fixed empty wakeup, detaches and discards a disconnected client', async () => {
  const client = new EventEmitter();
  const commands = [];
  const releases = [];
  let wakes = 0;
  let disconnects = 0;
  client.query = async (query) => { commands.push(query); };
  client.release = (error) => releases.push(error?.message ?? null);
  const release = await subscribePlatformProjectionNotifications({ async connect() { return client; } },
    () => { wakes += 1; }, () => { disconnects += 1; });
  client.emit('notification', { channel: 'other', payload: '' });
  client.emit('notification', { channel: 'cm_platform_projection', payload: 'tenant-shaped-input' });
  client.emit('notification', { channel: 'cm_platform_projection', payload: '' });
  assert.equal(wakes, 1);
  client.emit('error', new Error('sensitive connection details'));
  assert.equal(disconnects, 1);
  assert.deepEqual(releases, ['PLATFORM_PROJECTION_LISTENER_DISCONNECTED']);
  assert.equal(client.listenerCount('notification'), 0);
  await release();
  assert.deepEqual(commands, ['LISTEN cm_platform_projection']);
  assert.equal(releases.length, 1);
});

test('listener unlistens before returning a healthy connection to the pool', async () => {
  const client = new EventEmitter();
  const commands = [];
  client.query = async (query) => { commands.push(query); };
  client.release = (error) => { assert.equal(error, undefined); commands.push('release'); };
  const release = await subscribePlatformProjectionNotifications({ async connect() { return client; } }, () => {}, () => {});
  await release(); await release();
  assert.deepEqual(commands, ['LISTEN cm_platform_projection', 'UNLISTEN cm_platform_projection', 'release']);
});

test('single-connection pool preserves its only client for requests and durable polling', async () => {
  let acquired = false;
  const release = await subscribePlatformProjectionNotifications({ options: { max: 1 },
    async connect() { acquired = true; assert.fail('must not reserve the only client'); },
  }, () => {}, () => {});
  await release();
  assert.equal(acquired, false);
});

function failingProjection(attempts) {
  const queries = [];
  const client = {
    async query(input) {
      queries.push(input);
      if (typeof input === 'string') return { rows: [], rowCount: 0 };
      if (input.name === 'platform-projection-outbox-candidates') return { rows: [{ id: 'internal-tenant' }], rowCount: 1 };
      if (input.name === 'platform-projection-outbox-lock') return { rows: [{ source_version: '35', attempts }], rowCount: 1 };
      if (input.name === 'platform-projection-tenant-source') throw new Error('private failing source');
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const repository = createPostgresPlatformProjectionRepository({
    query: client.query, async connect() { return client; },
  });
  return { repository, queries };
}

test('failed rebuild rolls back before durable retry and poison evidence without acknowledging work', async () => {
  for (const [attempts, retryCount, poisonCount, delay] of [[0, 1, 0, 30], [4, 0, 1, 480]]) {
    const { repository, queries } = failingProjection(attempts);
    assert.deepEqual(await repository.consumeBatch({ limit: 1 }), { refreshedCount: 0, retryCount, poisonCount });
    const rollback = queries.indexOf('ROLLBACK TO SAVEPOINT platform_projection_event');
    const retry = queries.findIndex((query) => query.name === 'platform-projection-outbox-retry');
    assert.ok(rollback > 0 && retry > rollback);
    assert.deepEqual(queries[retry].values, ['internal-tenant', attempts + 1, delay, '35']);
    assert.equal(queries.some((query) => query.name === 'platform-projection-outbox-acknowledge'), false);
    assert.equal(queries.at(-1), 'COMMIT');
  }
});

test('projection telemetry has only fixed mode/outcome dimensions and rejects unbounded counts', () => {
  const metrics = createMetricsRegistry();
  metrics.recordProjectionBatch({ refreshedCount: 3, retryCount: 1, poisonCount: 1 });
  metrics.recordProjectionBatch({ reconciliationCount: 25 });
  const snapshot = metrics.snapshot();
  for (const sample of snapshot.counters) {
    assert.ok(['event', 'reconciliation'].includes(sample.labels.mode));
    assert.ok(Object.keys(sample.labels).every((key) => ['mode', 'outcome'].includes(key)));
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /private|credential|internal-tenant/);
  for (const value of [-1, 101, NaN, '1']) {
    assert.throws(() => metrics.recordProjectionBatch({ poisonCount: value }), /METRIC_PROJECTION_COUNT_INVALID/);
  }
});
