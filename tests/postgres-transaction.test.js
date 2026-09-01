import assert from 'node:assert/strict';
import test from 'node:test';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

function harness() {
  const queries = [];
  let connections = 0;
  const client = {
    async query(value) { queries.push(typeof value === 'string' ? value : value.name); return {}; },
    release(error) { queries.push(error ? 'RELEASE_ERROR' : 'RELEASE'); },
  };
  return {
    pool: { async connect() { connections += 1; return client; } },
    client,
    queries,
    connections: () => connections,
  };
}

test('nested work on the same pool joins the atomic outer transaction', async () => {
  const state = harness();
  const result = await withPostgresTransaction(state.pool, async (outer) => {
    return withPostgresTransaction(state.pool, async (inner) => {
      assert.equal(inner, outer);
      return 'joined';
    });
  }, { isolationLevel: 'SERIALIZABLE' });
  assert.equal(result, 'joined');
  assert.equal(state.connections(), 1);
  assert.deepEqual(state.queries, [
    'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'COMMIT',
    'RELEASE',
  ]);
});

test('nested work cannot silently demand stronger isolation or write through read-only authority', async () => {
  const first = harness();
  await assert.rejects(withPostgresTransaction(first.pool, () => {
    return withPostgresTransaction(first.pool, async () => true, { isolationLevel: 'SERIALIZABLE' });
  }), /NESTED_TRANSACTION_CONTRACT_INVALID/);
  assert.ok(first.queries.includes('ROLLBACK'));

  const second = harness();
  await assert.rejects(withPostgresTransaction(second.pool, () => {
    return withPostgresTransaction(second.pool, async () => true, { readOnly: false });
  }, { readOnly: true }), /NESTED_TRANSACTION_CONTRACT_INVALID/);
  assert.ok(second.queries.includes('ROLLBACK'));
});

test('transaction infrastructure mapping distinguishes connect, setup and commit failures', async () => {
  const phases = [];
  const mapper = (error, phase) => {
    phases.push(phase);
    return new Error(`MAPPED_${phase.toUpperCase()}`, { cause: error });
  };

  await assert.rejects(
    withPostgresTransaction({
      async connect() { throw new Error('connect detail'); },
    }, async () => true, { mapInfrastructureError: mapper }),
    /MAPPED_CONNECT/,
  );

  const setupQueries = [];
  await assert.rejects(withPostgresTransaction({
    async connect() {
      return {
        async query(query) {
          setupQueries.push(query);
          if (query === "SET LOCAL TIME ZONE 'UTC'") throw new Error('setup detail');
          return {};
        },
        release(error) { setupQueries.push(error ? 'RELEASE_ERROR' : 'RELEASE'); },
      };
    },
  }, async () => true, { mapInfrastructureError: mapper }), /MAPPED_SETUP/);
  assert.deepEqual(setupQueries, [
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'ROLLBACK',
    'RELEASE_ERROR',
  ]);

  const commitQueries = [];
  await assert.rejects(withPostgresTransaction({
    async connect() {
      return {
        async query(query) {
          commitQueries.push(query);
          if (query === 'COMMIT') throw new Error('commit detail');
          return {};
        },
        release(error) { commitQueries.push(error ? 'RELEASE_ERROR' : 'RELEASE'); },
      };
    },
  }, async () => 'result', { mapInfrastructureError: mapper }), /MAPPED_COMMIT/);
  assert.deepEqual(commitQueries, [
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'COMMIT',
    'ROLLBACK',
    'RELEASE_ERROR',
  ]);
  assert.deepEqual(phases, ['connect', 'setup', 'commit']);
});

test('transaction infrastructure mapping never rewrites work failures', async () => {
  const state = harness();
  const workFailure = new Error('BUSINESS_FAILURE');
  let mapperCalled = false;
  await assert.rejects(withPostgresTransaction(state.pool, async () => {
    throw workFailure;
  }, {
    mapInfrastructureError(error) {
      mapperCalled = true;
      return new Error('SHOULD_NOT_MAP', { cause: error });
    },
  }), (error) => error === workFailure);
  assert.equal(mapperCalled, false);
  assert.deepEqual(state.queries, [
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL TIME ZONE 'UTC'",
    'ROLLBACK',
    'RELEASE_ERROR',
  ]);
});

test('transaction infrastructure mapper contract fails closed', async () => {
  const state = harness();
  await assert.rejects(
    withPostgresTransaction(state.pool, async () => true, { mapInfrastructureError: 'invalid' }),
    /TRANSACTION_INFRASTRUCTURE_ERROR_MAPPER_INVALID/,
  );
  assert.equal(state.connections(), 0);

  await assert.rejects(withPostgresTransaction({
    async connect() { throw new Error('connect detail'); },
  }, async () => true, {
    mapInfrastructureError() { return 'not-an-error'; },
  }), /TRANSACTION_INFRASTRUCTURE_ERROR_MAPPER_RESULT_INVALID/);
});
