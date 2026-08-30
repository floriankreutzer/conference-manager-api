import { AsyncLocalStorage } from 'node:async_hooks';

const ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
const ISOLATION_RANK = new Map([
  ['READ COMMITTED', 1],
  ['REPEATABLE READ', 2],
  ['SERIALIZABLE', 3],
]);
const transactionContext = new AsyncLocalStorage();

function beginStatement({ isolationLevel = 'READ COMMITTED', readOnly = false } = {}) {
  if (!ISOLATION_LEVELS.has(isolationLevel)) throw new TypeError('TRANSACTION_ISOLATION_INVALID');
  if (typeof readOnly !== 'boolean') throw new TypeError('TRANSACTION_READ_ONLY_INVALID');
  return `BEGIN ISOLATION LEVEL ${isolationLevel} ${readOnly ? 'READ ONLY' : 'READ WRITE'}`;
}

export async function withPostgresTransaction(pool, work, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof work !== 'function') throw new TypeError('TRANSACTION_WORK_REQUIRED');

  const requested = Object.freeze({
    isolationLevel: options.isolationLevel || 'READ COMMITTED',
    readOnly: options.readOnly || false,
  });
  beginStatement(requested);
  const active = transactionContext.getStore();
  if (active?.pool === pool) {
    if (
      ISOLATION_RANK.get(requested.isolationLevel) > ISOLATION_RANK.get(active.isolationLevel)
      || (active.readOnly && !requested.readOnly)
    ) throw new TypeError('NESTED_TRANSACTION_CONTRACT_INVALID');
    return work(active.client);
  }

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query(beginStatement(requested));
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await transactionContext.run(Object.freeze({
      pool,
      client,
      isolationLevel: requested.isolationLevel,
      readOnly: requested.readOnly,
    }), () => work(client));
    await client.query('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original business/database failure. A poisoned connection is
        // discarded by node-postgres when release receives an error below.
      }
    }
    client.release(committed ? undefined : new Error('TRANSACTION_ABORTED'));
  }
}
