import { DEMO_RUNTIME_ADVISORY_LOCK } from '../../demo/runtime-contract.js';

export class DemoRuntimeGateError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'DemoRuntimeGateError';
    this.code = code;
  }
}

function assertGateInput(pool, work) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof work !== 'function') throw new TypeError('DEMO_RUNTIME_GATE_WORK_REQUIRED');
}

async function acquireGateClient(pool) {
  try {
    return await pool.connect();
  } catch (error) {
    throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_ACQUIRE_FAILED', { cause: error });
  }
}

async function rollbackQuietly(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original gate or application failure. The connection is discarded below.
  }
}

export async function withDemoRuntimeSharedGate(pool, work) {
  assertGateInput(pool, work);
  const client = await acquireGateClient(pool);
  let committed = false;
  try {
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
    } catch (error) {
      throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_ACQUIRE_FAILED', { cause: error });
    }

    const result = await work(client);

    try {
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_RELEASE_FAILED', { cause: error });
    }
    return result;
  } finally {
    if (!committed) await rollbackQuietly(client);
    client.release(committed ? undefined : new Error('DEMO_RUNTIME_GATE_TRANSACTION_ABORTED'));
  }
}

export async function acquireDemoRuntimeResetTransactionLock(client) {
  if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
  await client.query('SELECT pg_advisory_xact_lock($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
}
