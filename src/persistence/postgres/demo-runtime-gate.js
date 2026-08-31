import { DEMO_RUNTIME_ADVISORY_LOCK } from '../../demo/runtime-contract.js';
import { withPostgresTransaction } from './transaction.js';

export class DemoRuntimeGateError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'DemoRuntimeGateError';
    this.code = code;
  }
}

async function acquireTransactionGate(client, mode) {
  const shared = mode === 'shared';
  try {
    await client.query(
      shared ? 'SELECT pg_advisory_xact_lock_shared($1)' : 'SELECT pg_advisory_xact_lock($1)',
      [DEMO_RUNTIME_ADVISORY_LOCK],
    );
  } catch (error) {
    throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_ACQUIRE_FAILED', { cause: error });
  }
}

async function withGate(pool, work, mode) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof work !== 'function') throw new TypeError('DEMO_RUNTIME_GATE_WORK_REQUIRED');
  try {
    return await withPostgresTransaction(pool, async (client) => {
      await acquireTransactionGate(client, mode);
      return work(client);
    });
  } catch (error) {
    if (error instanceof DemoRuntimeGateError) throw error;
    throw error;
  }
}

export async function withDemoRuntimeSharedGate(pool, work) {
  return withGate(pool, work, 'shared');
}

export async function withDemoRuntimeExclusiveGate(pool, work) {
  return withGate(pool, work, 'exclusive');
}

export async function acquireDemoRuntimeResetTransactionLock(client) {
  if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
  } catch (error) {
    throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_ACQUIRE_FAILED', { cause: error });
  }
}
