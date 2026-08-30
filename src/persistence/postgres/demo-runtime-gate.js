import { DEMO_RUNTIME_ADVISORY_LOCK } from '../../demo/runtime-contract.js';

export class DemoRuntimeGateError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'DemoRuntimeGateError';
    this.code = code;
  }
}

async function withGate(pool, work, mode) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof work !== 'function') throw new TypeError('DEMO_RUNTIME_GATE_WORK_REQUIRED');
  const shared = mode === 'shared';
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_ACQUIRE_FAILED', { cause: error });
  }
  try {
    await client.query(
      shared ? 'SELECT pg_advisory_lock_shared($1)' : 'SELECT pg_advisory_lock($1)',
      [DEMO_RUNTIME_ADVISORY_LOCK],
    );
  } catch (error) {
    client.release(error);
    throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_ACQUIRE_FAILED', { cause: error });
  }

  let result;
  let workError;
  try {
    result = await work(client);
  } catch (error) {
    workError = error;
  }

  let unlockError;
  try {
    const result = await client.query(
      shared ? 'SELECT pg_advisory_unlock_shared($1)' : 'SELECT pg_advisory_unlock($1)',
      [DEMO_RUNTIME_ADVISORY_LOCK],
    );
    const released = shared
      ? result.rows[0]?.pg_advisory_unlock_shared
      : result.rows[0]?.pg_advisory_unlock;
    if (released !== true) unlockError = new Error('DEMO_RUNTIME_GATE_NOT_HELD');
  } catch (error) {
    unlockError = error;
  }
  client.release(unlockError);
  if (workError) throw workError;
  if (unlockError) {
    throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_RELEASE_FAILED', { cause: unlockError });
  }
  return result;
}

export async function withDemoRuntimeSharedGate(pool, work) {
  return withGate(pool, work, 'shared');
}

export async function withDemoRuntimeExclusiveGate(pool, work) {
  return withGate(pool, work, 'exclusive');
}

export async function acquireDemoRuntimeResetTransactionLock(client) {
  if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
  await client.query('SELECT pg_advisory_xact_lock($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
}
