import test from 'node:test';
import assert from 'node:assert/strict';
import { startDemoMediaStorageRuntime } from '../src/demo/media-storage-runtime.js';
import { demoMediaStorageEnvironment, demoMediaStorageConfig } from './support/demo-media-storage-environment.js';

const RAW_ERROR = 'synthetic raw dependency failure containing private connection details';

function harness({ surface = 'customer', mode = 'neon', overrides = {}, failure, identity, inconsistent = false } = {}) {
  const env = demoMediaStorageEnvironment(surface, mode, overrides);
  const config = demoMediaStorageConfig(env, surface);
  const events = [];
  const role = surface === 'customer' ? 'cm_demo_customer' : 'cm_demo_reset';
  const storage = { close() { events.push('storage.close'); if (failure === 'storage.close') throw new Error(RAW_ERROR); } };
  const dependencies = {
    poolFactory(settings) {
      events.push('pool.create');
      assert.equal(settings.databasePoolMax, 1);
      assert.equal(settings.databaseStatementTimeoutMs, 5000);
      assert.equal(settings.databaseConnectionTimeoutMs, 5000);
      assert.equal(settings.databaseSsl, 'verify-full');
      assert.equal(new URL(settings.databaseUrl).username, role);
      if (failure === 'pool.create') throw new Error(RAW_ERROR);
      return {
        async query(query) {
          events.push(query.name);
          if (failure === query.name) throw new Error(RAW_ERROR);
          if (query.name === 'demo-media-storage-identity') return { rows: [identity || {
            role, database: 'conference_manager_demo_shared',
          }] };
          assert.equal(query.name, 'demo-media-storage-mode');
          assert.deepEqual(query.values, [mode === 'neon']);
          return { rows: [{ inconsistent }] };
        },
        async end() { events.push('pool.end'); if (failure === 'pool.end') throw new Error(RAW_ERROR); },
      };
    },
    storageFactory(settings) {
      events.push('storage.create');
      assert.equal(events.at(-2), 'pool.end');
      assert.equal(settings.bucket, 'conference-manager-media');
      if (failure === 'storage.create') throw new Error(RAW_ERROR);
      return storage;
    },
  };
  const options = { env, config, surface,
    createComposition(port) {
      events.push('composition.create');
      assert.equal(port, mode === 'neon' ? storage : null);
      if (failure === 'composition.create') throw new Error(RAW_ERROR);
      return {
        async start() { events.push('composition.start'); if (failure === 'composition.start') throw new Error(RAW_ERROR); },
        async stop() { events.push('composition.stop'); if (failure === 'composition.stop') throw new Error(RAW_ERROR); },
      };
    } };
  return { events, options, dependencies, run: () => startDemoMediaStorageRuntime(options, dependencies) };
}

function safeFailure(code) {
  return (error) => {
    assert.equal(error.message, code);
    assert.equal(String(error).includes(RAW_ERROR), false);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('both normal surfaces verify live database/mode and close the probe pool before allocating Neon', async () => {
  for (const surface of ['customer', 'platform']) {
    const state = harness({ surface });
    const runtime = await state.run();
    assert.deepEqual(state.events, ['pool.create', 'demo-media-storage-identity', 'demo-media-storage-mode',
      'pool.end', 'storage.create', 'composition.create', 'composition.start']);
    await runtime.stop();
    await runtime.stop();
    assert.deepEqual(state.events.slice(-2), ['composition.stop', 'storage.close']);
    assert.equal(state.events.filter((event) => event === 'storage.close').length, 1);
  }
});

test('PostgreSQL remains explicit/default and never allocates a provider on either surface', async () => {
  for (const surface of ['customer', 'platform']) {
    const state = harness({ surface, mode: 'postgres', overrides: { DEMO_MEDIA_STORAGE: undefined } });
    const runtime = await state.run();
    await runtime.stop();
    assert.deepEqual(state.events, ['pool.create', 'demo-media-storage-identity', 'demo-media-storage-mode',
      'pool.end', 'composition.create', 'composition.start', 'composition.stop']);
  }
});

test('bad configuration aborts before pool, SDK or composition allocation', async () => {
  const state = harness({ overrides: { DEMO_MEDIA_STORAGE_DATABASE_HOST: '127.0.0.1' } });
  await assert.rejects(state.run(), safeFailure('DEMO_MEDIA_STORAGE_DATABASE_BINDING_INVALID'));
  assert.deepEqual(state.events, []);
});

test('wrong live principal/database fail before asset inspection and provider allocation', async () => {
  for (const identity of [{ role: 'cm_demo_migration', database: 'conference_manager_demo_shared' },
    { role: 'cm_demo_customer', database: 'conference_manager_demo_other' }]) {
    const state = harness({ identity });
    await assert.rejects(state.run(), safeFailure('DEMO_MEDIA_STORAGE_IDENTITY_INVALID'));
    assert.deepEqual(state.events, ['pool.create', 'demo-media-storage-identity', 'pool.end']);
  }
});

test('both mixed-state directions and unknown mode results fail before SDK and listener startup', async () => {
  for (const mode of ['postgres', 'neon']) {
    for (const inconsistent of [true, null, undefined, 'false']) {
      const state = harness({ mode, inconsistent: inconsistent === undefined ? 0 : inconsistent });
      await assert.rejects(state.run(), safeFailure('DEMO_MEDIA_STORAGE_MODE_MISMATCH'));
      assert.deepEqual(state.events, ['pool.create', 'demo-media-storage-identity', 'demo-media-storage-mode', 'pool.end']);
    }
  }
});

test('pool construction, query and close failures remain bounded and never allocate storage', async () => {
  for (const failure of ['pool.create', 'demo-media-storage-identity', 'demo-media-storage-mode', 'pool.end']) {
    const state = harness({ failure });
    await assert.rejects(state.run(), safeFailure('DEMO_MEDIA_STORAGE_READINESS_FAILED'));
    assert.equal(state.events.includes('storage.create'), false);
    assert.equal(state.events.includes('composition.create'), false);
    assert.equal(state.events.includes('pool.end'), failure !== 'pool.create');
  }
});

test('SDK and composition failures close every successfully allocated startup resource', async () => {
  for (const failure of ['storage.create', 'composition.create', 'composition.start']) {
    const state = harness({ failure });
    await assert.rejects(state.run(), safeFailure('DEMO_MEDIA_STORAGE_START_FAILED'));
    assert.equal(state.events.filter((event) => event === 'pool.end').length, 1);
    assert.equal(state.events.includes('storage.close'), failure !== 'storage.create');
    assert.equal(state.events.includes('composition.stop'), failure === 'composition.start');
  }
});

test('shutdown failures still release the adapter once and cannot leak dependency errors', async () => {
  for (const failure of ['composition.stop', 'storage.close']) {
    const state = harness({ failure });
    const runtime = await state.run();
    await assert.rejects(runtime.stop(), safeFailure('DEMO_MEDIA_STORAGE_STOP_FAILED'));
    await runtime.stop();
    assert.deepEqual(state.events.slice(-2), ['composition.stop', 'storage.close']);
    assert.equal(state.events.filter((event) => event === 'storage.close').length, 1);
  }
});
