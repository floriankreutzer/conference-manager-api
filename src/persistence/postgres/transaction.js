const ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

function beginStatement({ isolationLevel = 'READ COMMITTED', readOnly = false } = {}) {
  if (!ISOLATION_LEVELS.has(isolationLevel)) throw new TypeError('TRANSACTION_ISOLATION_INVALID');
  if (typeof readOnly !== 'boolean') throw new TypeError('TRANSACTION_READ_ONLY_INVALID');
  return `BEGIN ISOLATION LEVEL ${isolationLevel} ${readOnly ? 'READ ONLY' : 'READ WRITE'}`;
}

export async function withPostgresTransaction(pool, work, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof work !== 'function') throw new TypeError('TRANSACTION_WORK_REQUIRED');

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query(beginStatement(options));
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await work(client);
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
