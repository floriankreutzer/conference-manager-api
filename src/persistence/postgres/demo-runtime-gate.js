import { DEMO_RUNTIME_ADVISORY_LOCK } from '../../demo/runtime-contract.js';
import { withPostgresTransaction } from './transaction.js';

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

function mapTransactionInfrastructureError(error, phase) {
  const code = phase === 'commit'
    ? 'DEMO_RUNTIME_GATE_RELEASE_FAILED'
    : 'DEMO_RUNTIME_GATE_ACQUIRE_FAILED';
  return new DemoRuntimeGateError(code, { cause: error });
}

export async function withDemoRuntimeSharedGate(pool, work) {
  assertGateInput(pool, work);
  return withPostgresTransaction(pool, async (client) => {
    try {
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
    } catch (error) {
      throw new DemoRuntimeGateError('DEMO_RUNTIME_GATE_ACQUIRE_FAILED', { cause: error });
    }
    return work(client);
  }, {
    mapInfrastructureError: mapTransactionInfrastructureError,
  });
}

export async function acquireDemoRuntimeResetTransactionLock(client) {
  if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
  await client.query('SELECT pg_advisory_xact_lock($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
}
