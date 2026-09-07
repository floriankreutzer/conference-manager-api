import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DemoRuntimeGateError,
  withDemoRuntimeSharedGate,
} from '../src/persistence/postgres/demo-runtime-gate.js';

test('shared Demo runtime gate delegates transaction lifecycle to the canonical helper', async () => {
  const source = await readFile(new URL('../src/persistence/postgres/demo-runtime-gate.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ withPostgresTransaction \} from '\.\/transaction\.js';/);
  assert.match(source, /return withPostgresTransaction\(pool,/);
  assert.doesNotMatch(source, /client\.query\(['"]BEGIN/);
  assert.doesNotMatch(source, /client\.query\(['"]COMMIT/);
  assert.doesNotMatch(source, /client\.query\(['"]ROLLBACK/);
  assert.doesNotMatch(source, /client\.release\(/);
});

test('shared Demo runtime gate uses a transaction-scoped advisory lock', async () => {
  const queries = [];
  let releasedWith;
  const client = {
    async query(query) {
      queries.push(query);
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
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'SELECT pg_advisory_xact_lock_shared($1)',
    'COMMIT',
  ]);
  assert.equal(releasedWith, undefined);
});

test('shared Demo runtime gate rolls back and discards the connection when lock acquisition fails', async () => {
  const queries = [];
  let releasedWith;
  const client = {
    async query(query) {
      queries.push(query);
      if (query === 'SELECT pg_advisory_xact_lock_shared($1)') {
        throw new Error('postgresql://sensitive-user:sensitive-password@database.internal/demo');
      }
      return { rows: [] };
    },
    release(error) {
      releasedWith = error;
    },
  };
  await assert.rejects(
    withDemoRuntimeSharedGate({ async connect() { return client; } }, async () => true),
    (error) => error instanceof DemoRuntimeGateError
      && error.code === 'DEMO_RUNTIME_GATE_ACQUIRE_FAILED'
      && error.message === 'DEMO_RUNTIME_GATE_ACQUIRE_FAILED',
  );
  assert.deepEqual(queries, [
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'SELECT pg_advisory_xact_lock_shared($1)',
    'ROLLBACK',
  ]);
  assert.equal(releasedWith instanceof Error, true);
});

test('shared Demo runtime gate normalizes transaction setup failure without exposing driver detail', async () => {
  const queries = [];
  let releasedWith;
  const client = {
    async query(query) {
      queries.push(query);
      if (query === "SET LOCAL TIME ZONE 'UTC'") {
        throw new Error('postgresql://sensitive-user:sensitive-password@database.internal/demo');
      }
      return { rows: [] };
    },
    release(error) {
      releasedWith = error;
    },
  };
  await assert.rejects(
    withDemoRuntimeSharedGate({ async connect() { return client; } }, async () => true),
    (error) => error instanceof DemoRuntimeGateError
      && error.code === 'DEMO_RUNTIME_GATE_ACQUIRE_FAILED'
      && error.message === 'DEMO_RUNTIME_GATE_ACQUIRE_FAILED',
  );
  assert.deepEqual(queries, [
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'ROLLBACK',
  ]);
  assert.equal(releasedWith instanceof Error, true);
});

test('shared Demo runtime gate normalizes commit failure as runtime unavailability', async () => {
  const queries = [];
  let releasedWith;
  const client = {
    async query(query) {
      queries.push(query);
      if (query === 'COMMIT') throw new Error('sensitive commit driver detail');
      return { rows: [] };
    },
    release(error) {
      releasedWith = error;
    },
  };
  await assert.rejects(
    withDemoRuntimeSharedGate({ async connect() { return client; } }, async () => 'complete'),
    (error) => error instanceof DemoRuntimeGateError
      && error.code === 'DEMO_RUNTIME_GATE_RELEASE_FAILED'
      && error.message === 'DEMO_RUNTIME_GATE_RELEASE_FAILED',
  );
  assert.deepEqual(queries, [
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'SELECT pg_advisory_xact_lock_shared($1)',
    'COMMIT',
    'ROLLBACK',
  ]);
  assert.equal(releasedWith instanceof Error, true);
});

test('shared Demo runtime gate preserves application failure while rolling back the gate transaction', async () => {
  const queries = [];
  let releasedWith;
  const applicationError = new Error('APPLICATION_FAILURE');
  const client = {
    async query(query) {
      queries.push(query);
      return { rows: [] };
    },
    release(error) {
      releasedWith = error;
    },
  };
  await assert.rejects(
    withDemoRuntimeSharedGate({ async connect() { return client; } }, async () => {
      throw applicationError;
    }),
    (error) => error === applicationError,
  );
  assert.deepEqual(queries, [
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'SELECT pg_advisory_xact_lock_shared($1)',
    'ROLLBACK',
  ]);
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
