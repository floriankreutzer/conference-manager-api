import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { startTargetLoadRuntime } from '../scripts/target-load-runtime.mjs';
import { NOW, targetLoadEnvironment } from './support/target-load-environment.js';

function fixture(surface = 'customer', changes = {}) {
  const env = { ...targetLoadEnvironment(surface), ...changes }; const steps = []; const exits = [];
  let now = NOW; let options; let storagePort; let closed = 0; let objectClosed = 0; let started = 0; let stopped = 0;
  const probe = JSON.parse(targetLoadEnvironment().LOAD_STORAGE_PROBE_JSON);
  const rows = Array.from({ length: 10 }, (_, index) => ({ tenant_id: index === 0 ? probe.tenantId : randomUUID(),
    reference: randomUUID(), address: `room${index}@synthetic.invalid` }));
  const persistence = { pool: { async query(sql) {
    steps.push('query');
    if (sql.includes('EXISTS')) return { rows: [{ present: false }], rowCount: 1 };
    return { rows, rowCount: rows.length };
  } }, async close() { closed += 1; } };
  const storage = { async get(reference) { steps.push('object-probe'); assert.equal(reference.assetId, probe.assetId); },
    close() { objectClosed += 1; } };
  const compose = value => { options = value; steps.push('compose'); return {
    async start() { started += 1; }, async stop() { stopped += 1; await persistence.close(); },
  }; };
  const dependencies = { env, clock: () => now, exit: code => exits.push(code),
    customerPersistence(_config, value) {
      steps.push('customer-persistence'); assert.equal(typeof value.mediaObjectStorage.get, 'function');
      storagePort = value.mediaObjectStorage; return persistence;
    },
    platformPersistence() { steps.push('platform-persistence'); return persistence; },
    storageFactory() { steps.push('storage-constructor'); return storage; },
    customerComposition: compose, platformComposition: compose,
    async verifyDatabase(_pool, scope) { steps.push('database-guard'); assert.equal(scope.surface, surface); } };
  return { env, dependencies, persistence, rows, storage, steps, exits, time: value => { now = value; },
    state: () => ({ options, storagePort, closed, objectClosed, started, stopped }) };
}

test('target runtime verifies authority before fixture/object I/O and composes only the selected canonical surface', async () => {
  for (const surface of ['customer', 'platform']) {
    const value = fixture(surface); const runtime = await startTargetLoadRuntime(value.dependencies);
    const state = value.state(); assert.equal(state.started, 1);
    assert.ok(value.steps.indexOf('database-guard') < value.steps.indexOf('compose'));
    assert.equal(typeof state.options.httpServerFactory, 'function');
    assert.equal(state.options.config.databaseSsl, 'verify-full');
    if (surface === 'customer') {
      assert.ok(value.steps.indexOf('database-guard') < value.steps.indexOf('object-probe'));
      assert.equal(state.options.entraClient, null); assert.equal(typeof state.options.microsoft365Client.createCalendarEvent, 'function');
    } else {
      assert.ok(!value.steps.includes('storage-constructor')); assert.equal(state.options.authenticationFactory, undefined);
      let work = 0; assert.equal(await state.options.projectionRunGate(async () => { work += 1; return 'ok'; }), 'ok');
      assert.equal(work, 1);
    }
    await Promise.all([runtime.stop(), runtime.stop()]);
    assert.equal(value.state().stopped, 1); assert.equal(value.state().closed, 1);
    assert.equal(value.state().objectClosed, surface === 'customer' ? 1 : 0);
    assert.deepEqual(value.exits, []);
  }
});

test('invalid runtime configuration fails before any dependency allocation', async () => {
  const value = fixture('customer', { RENDER_GIT_BRANCH: 'unmerged' });
  await assert.rejects(startTargetLoadRuntime(value.dependencies), /^Error: LOAD_TARGET_RUNTIME_FAILED$/);
  assert.deepEqual(value.steps, []);
});

test('guard failure, prior booking state, foreign probe and malformed provider binding stop before listening', async () => {
  for (const fault of ['guard', 'prior-booking', 'foreign-probe', 'provider-binding', 'expiry']) {
    const value = fixture();
    if (fault === 'guard') value.dependencies.verifyDatabase = async () => { throw new Error('private-postgres-material'); };
    if (fault === 'prior-booking') value.persistence.pool.query = async () => ({ rows: [{ present: true }] });
    if (fault === 'foreign-probe') value.rows[0].tenant_id = randomUUID();
    if (fault === 'provider-binding') value.rows[0].address = 'private-room@real.invalid';
    if (fault === 'expiry') value.dependencies.verifyDatabase = async () => { value.time(NOW + 60_000); };
    await assert.rejects(startTargetLoadRuntime(value.dependencies), /^Error: LOAD_TARGET_RUNTIME_FAILED$/);
    assert.equal(value.state().started, 0); assert.equal(value.state().closed, 1); assert.equal(value.state().objectClosed, 1);
    assert.ok(!value.steps.includes('object-probe'));
  }
});

test('an expired asynchronous startup drains once and cannot listen after shutdown', { timeout: 2000 }, async () => {
  const value = fixture('customer', { LOAD_EXPIRES_AT: new Date(NOW + 10_025).toISOString() });
  let release; let stopped = 0;
  const pending = new Promise(resolve => { release = resolve; });
  value.dependencies.customerComposition = () => ({ start: () => pending,
    async stop() { stopped += 1; await value.persistence.close(); } });
  const starting = startTargetLoadRuntime(value.dependencies);
  const checked = assert.rejects(starting, /^Error: LOAD_TARGET_RUNTIME_FAILED$/);
  await new Promise(resolve => setTimeout(resolve, 50)); release(); await checked;
  assert.equal(stopped, 1); assert.equal(value.state().closed, 1); assert.equal(value.state().objectClosed, 1);
  assert.deepEqual(value.exits, [0]);
});

test('target CLI rejects invalid authority with one fixed error before provider I/O', () => {
  const result = spawnSync(process.execPath, ['scripts/target-load-runtime.mjs'], {
    env: { ...process.env, LOAD_DATABASE_URL: 'private-existing-material', LOAD_RUN_ID: 'invalid' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'LOAD_TARGET_RUNTIME_FAILED\n');
});


test('the absolute hard-exit deadline survives a wedged graceful shutdown', { timeout: 12_000 }, async t => {
  const value = fixture('customer', { LOAD_EXPIRES_AT: new Date(NOW + 10_025).toISOString() });
  const server = http.createServer((_request, response) => response.end());
  let release; let stopCalls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  let exited;
  const exitObserved = new Promise(resolve => { exited = resolve; });
  value.dependencies.exit = code => { value.exits.push(code); exited(); };
  value.dependencies.customerComposition = () => ({
    async start() { server.listen(0, '127.0.0.1'); await once(server, 'listening'); },
    async stop() {
      stopCalls += 1; await blocked;
      await new Promise(resolve => server.close(resolve)); await value.persistence.close();
    },
  });
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const runtime = await startTargetLoadRuntime(value.dependencies);
  await exitObserved;
  assert.equal(stopCalls, 1); assert.deepEqual(value.exits, [1]);
  release(); await runtime.stop();
  assert.equal(value.state().closed, 1); assert.equal(value.state().objectClosed, 1);
});


test('concurrent storage writes reserve the fixed body budget before provider work', async () => {
  const value = fixture(); let writes = 0;
  value.storage.put = async () => { writes += 1; return 'stored'; };
  const runtime = await startTargetLoadRuntime(value.dependencies);
  try {
    const probe = JSON.parse(value.env.LOAD_STORAGE_PROBE_JSON);
    const reference = { ...probe, kind: 'room', contentType: 'image/webp', byteLength: 2 * 1024 * 1024 };
    const outcomes = await Promise.allSettled(Array.from({ length: 32 }, () =>
      value.state().storagePort.put(reference, Buffer.alloc(0))));
    assert.equal(writes, 9); assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 9);
    assert.ok(outcomes.filter(row => row.status === 'rejected').every(row => row.reason.message === 'MEDIA_STORAGE_UNAVAILABLE'));
  } finally { await runtime.stop(); }
});
