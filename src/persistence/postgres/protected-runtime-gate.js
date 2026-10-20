import { AsyncLocalStorage } from 'node:async_hooks';
import { isPostgresTransactionActive,withPostgresTransaction } from './transaction.js';

const context=new AsyncLocalStorage();
const LOCK_NAMESPACE=740193;
const ENVIRONMENT_LOCKS=Object.freeze({ dev: 1,int: 2,prod: 3 });
const STATEMENTS=Object.freeze({
  shared: 'SELECT pg_try_advisory_xact_lock_shared($1,$2) AS acquired',
  exclusive: 'SELECT pg_try_advisory_xact_lock($1,$2) AS acquired',
});

export class ProtectedRuntimeGateError extends Error {
  constructor(code) { super(code);this.name='ProtectedRuntimeGateError';this.code=code; }
}

async function run(pool,environment,mode,work,isolationLevel='READ COMMITTED') {
  if (!pool || typeof pool.connect!=='function' || typeof environment!=='string' || !Object.hasOwn(ENVIRONMENT_LOCKS,environment)
    || typeof work!=='function') throw new TypeError('PROTECTED_RUNTIME_GATE_CONFIGURATION_INVALID');
  const active=context.getStore();
  if (active) {
    if (!active.lease.active || active.pool!==pool || active.environment!==environment || mode==='exclusive' && active.mode!=='exclusive'
      || isolationLevel==='REPEATABLE READ' && active.isolationLevel!=='REPEATABLE READ'
      || !isPostgresTransactionActive(pool,active.client)) {
      throw new ProtectedRuntimeGateError('PROTECTED_RUNTIME_GATE_SCOPE_INVALID');
    }
    return work(active.client);
  }
  // Acquire before business locks. Joining an unmarked transaction or upgrading
  // a shared gate could deadlock against reset; neither is a supported contract.
  if (isPostgresTransactionActive(pool)) throw new ProtectedRuntimeGateError('PROTECTED_RUNTIME_GATE_ORDER_INVALID');
  return withPostgresTransaction(pool,async client=>{
    const result=await client.query({ text: STATEMENTS[mode],values: [LOCK_NAMESPACE,ENVIRONMENT_LOCKS[environment]] });
    if (result.rows?.[0]?.acquired!==true) throw new ProtectedRuntimeGateError('PROTECTED_RUNTIME_BUSY');
    const lease={ active: true };
    return context.run(Object.freeze({ pool,environment,mode,client,lease,isolationLevel }),async()=>{
      try { return await work(client); } finally { lease.active=false; }
    });
  },{ isolationLevel });
}

// HTTP/worker scopes acquire shared before identity/business work. Reset and
// coordinated epoch changes acquire exclusive before any business/proof locks.
// Contention rejects immediately: this layer has no polling, retry or timeout
// extension, and PostgreSQL releases the lease on commit/rollback/connection loss.
export function withProtectedRuntimeSharedGate(pool,environment,work) {
  return run(pool,environment,'shared',work);
}

export function withProtectedRuntimeExclusiveGate(pool,environment,work) {
  return run(pool,environment,'exclusive',work);
}

// Exact-operation proof and its mutation must share one writable RR transaction.
// A caller using this entry must lock/revalidate mutable custody after acquiring
// the advisory lease: that initial SELECT can already have fixed an older snapshot.
export function withProtectedRuntimeRepeatableExclusiveGate(pool,environment,work) {
  return run(pool,environment,'exclusive',work,'REPEATABLE READ');
}
