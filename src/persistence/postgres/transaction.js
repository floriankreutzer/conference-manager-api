export async function withPostgresTransaction(pool, work) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof work !== 'function') throw new TypeError('TRANSACTION_WORK_REQUIRED');

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
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
