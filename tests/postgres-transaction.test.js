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
