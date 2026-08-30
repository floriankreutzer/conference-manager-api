import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DemoRuntimeGateError,
  withDemoRuntimeSharedGate,
} from '../src/persistence/postgres/demo-runtime-gate.js';

test('shared Demo runtime gate holds and releases one checked-out lease', async () => {
  const queries = [];
  let releasedWith;
  const client = {
    async query(text) {
      queries.push(text);
      if (text.includes('unlock_shared')) return { rows: [{ pg_advisory_unlock_shared: true }] };
      return { rows: [] };
    },
    release(error) {
      releasedWith = error;
    },
  };
  const result = await withDemoRuntimeSharedGate({ async connect() { return client; } }, async (leased) => {
    assert.equal(leased, client);
    return 'complete';
  });
  assert.equal(result, 'complete');
  assert.deepEqual(queries, [
    'SELECT pg_advisory_lock_shared($1)',
    'SELECT pg_advisory_unlock_shared($1)',
  ]);
  assert.equal(releasedWith, undefined);
});

test('shared Demo runtime gate discards a connection when PostgreSQL reports no held lock', async () => {
  let releasedWith;
  const client = {
    async query(text) {
      if (text.includes('unlock_shared')) return { rows: [{ pg_advisory_unlock_shared: false }] };
      return { rows: [] };
    },
    release(error) {
      releasedWith = error;
    },
  };
  await assert.rejects(
    withDemoRuntimeSharedGate({ async connect() { return client; } }, async () => true),
    (error) => error instanceof DemoRuntimeGateError && error.code === 'DEMO_RUNTIME_GATE_RELEASE_FAILED',
  );
  assert.equal(releasedWith instanceof Error, true);
});

test('shared Demo runtime gate normalizes pool acquisition failure without exposing driver detail', async () => {
  await assert.rejects(
    withDemoRuntimeSharedGate({
      async connect() {
        throw new Error('postgresql://sensitive-user:sensitive-password@database.internal/demo');
      },
    }, async () => true),
    (error) => error instanceof DemoRuntimeGateError
      && error.code === 'DEMO_RUNTIME_GATE_ACQUIRE_FAILED'
      && error.message === 'DEMO_RUNTIME_GATE_ACQUIRE_FAILED',
  );
});
