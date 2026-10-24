import { AsyncLocalStorage } from 'node:async_hooks';

const ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
const ISOLATION_RANK = new Map([
  ['READ COMMITTED', 1],
  ['REPEATABLE READ', 2],
  ['SERIALIZABLE', 3],
]);
const TRANSACTION_INFRASTRUCTURE_PHASE = Object.freeze({
  CONNECT: 'connect',
  SETUP: 'setup',
  COMMIT: 'commit',
});
const transactionContext = new AsyncLocalStorage();
const authorityScopes = new WeakMap();

// Optional process-owned write precondition. This infrastructure layer knows no
// provider, Tenant, role or owner policy. The owning protected composition admits
// an already-qualified immutable authority before business transactions begin.
// Unregistered pools and ordinary unadmitted work retain their existing path.
export function createPostgresTransactionAuthorityScope(pool,{ beforeWrite,denied }={}) {
  if (!pool || typeof pool.connect!=='function' || typeof beforeWrite!=='function' || typeof denied!=='function'
    || authorityScopes.has(pool)) throw new TypeError('TRANSACTION_AUTHORITY_CONFIGURATION_INVALID');
  const context=new AsyncLocalStorage();
  function reject() {
    const error=denied();
    if (!(error instanceof Error)) throw new TypeError('TRANSACTION_AUTHORITY_DENIAL_INVALID');
    throw error;
  }
  async function before(frame) {
    const active=context.getStore();
    if (!active) return;
    if (!active.live) reject();
    if (!active.authority || active.validated.has(frame)) return;
    if (active.validating.has(frame)) reject();
    active.validating.add(frame);
    try {
      if (await beforeWrite(frame.client,active.authority)!==true) reject();
      if (!active.live) reject();
      active.validated.add(frame);
    } finally { active.validating.delete(frame); }
  }
  authorityScopes.set(pool,before);
  return Object.freeze({
    async run(work) {
      if (typeof work!=='function') throw new TypeError('TRANSACTION_AUTHORITY_WORK_REQUIRED');
      const enclosing=context.getStore();
      if (enclosing) {
        if (!enclosing.live) reject();
        return work();
      }
      const active={ live: true,authority: null,key: null,validated: new WeakSet(),validating: new WeakSet() };
      return context.run(active,async()=>{
        try { return await work(); } finally { active.live=false; }
      });
    },
    hasAuthority() {
      const active=context.getStore();
      if (active && !active.live) reject();
      return Boolean(active?.authority);
    },
    admit(authority,key) {
      const active=context.getStore();
      if (!active?.live || isPostgresTransactionActive(pool) || !authority || !Object.isFrozen(authority)
        || typeof key!=='string' || key.length<1 || key.length>16384 || active.key!==null && active.key!==key) reject();
      if (active.authority===null) { active.authority=authority;active.key=key; }
      return true;
    },
  });
}

async function requireWriteAuthority(pool,frame,readOnly) {
  if (!readOnly) await authorityScopes.get(pool)?.(frame);
}

export function isPostgresTransactionActive(pool, client) {
  const active = transactionContext.getStore();
  return active?.pool === pool && (client === undefined || active.client === client);
}

function beginStatement({ isolationLevel = 'READ COMMITTED', readOnly = false } = {}) {
  if (!ISOLATION_LEVELS.has(isolationLevel)) throw new TypeError('TRANSACTION_ISOLATION_INVALID');
  if (typeof readOnly !== 'boolean') throw new TypeError('TRANSACTION_READ_ONLY_INVALID');
  return `BEGIN ISOLATION LEVEL ${isolationLevel} ${readOnly ? 'READ ONLY' : 'READ WRITE'}`;
}

function normalizedInfrastructureErrorMapper(value) {
  if (value === undefined) return null;
  if (typeof value !== 'function') throw new TypeError('TRANSACTION_INFRASTRUCTURE_ERROR_MAPPER_INVALID');
  return value;
}

function infrastructureError(error, mapper, phase) {
  if (!mapper) return error;
  const mapped = mapper(error, phase);
  if (!(mapped instanceof Error)) throw new TypeError('TRANSACTION_INFRASTRUCTURE_ERROR_MAPPER_RESULT_INVALID');
  return mapped;
}

export async function withPostgresTransaction(pool, work, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (typeof work !== 'function') throw new TypeError('TRANSACTION_WORK_REQUIRED');

  const requested = Object.freeze({
    isolationLevel: options.isolationLevel || 'READ COMMITTED',
    readOnly: options.readOnly || false,
  });
  const mapInfrastructureError = normalizedInfrastructureErrorMapper(options.mapInfrastructureError);
  beginStatement(requested);
  const active = transactionContext.getStore();
  if (active?.pool === pool) {
    if (
      ISOLATION_RANK.get(requested.isolationLevel) > ISOLATION_RANK.get(active.isolationLevel)
      || (active.readOnly && !requested.readOnly)
    ) throw new TypeError('NESTED_TRANSACTION_CONTRACT_INVALID');
    await requireWriteAuthority(pool,active,requested.readOnly);
    return work(active.client);
  }

  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    throw infrastructureError(error, mapInfrastructureError, TRANSACTION_INFRASTRUCTURE_PHASE.CONNECT);
  }

  let committed = false;
  try {
    try {
      await client.query(beginStatement(requested));
      await client.query("SET LOCAL TIME ZONE 'UTC'");
    } catch (error) {
      throw infrastructureError(error, mapInfrastructureError, TRANSACTION_INFRASTRUCTURE_PHASE.SETUP);
    }

    const frame=Object.freeze({
      pool,
      client,
      isolationLevel: requested.isolationLevel,
      readOnly: requested.readOnly,
    });
    const result = await transactionContext.run(frame,async()=>{
      await requireWriteAuthority(pool,frame,requested.readOnly);
      return work(client);
    });

    try {
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      throw infrastructureError(error, mapInfrastructureError, TRANSACTION_INFRASTRUCTURE_PHASE.COMMIT);
    }
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
