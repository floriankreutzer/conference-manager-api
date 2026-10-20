import { isInternalUuid } from '../../domain/identifiers.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { isPostgresTransactionActive } from './transaction.js';
import {
  ProtectedRuntimeGateError,withProtectedRuntimeSharedGate,withProtectedRuntimeRepeatableExclusiveGate,
} from './protected-runtime-gate.js';

function poolPort(pool) { return pool && typeof pool.query==='function' && typeof pool.connect==='function'; }
function denied(code) { throw new ProtectedRuntimeGateError(code); }
const syntheticContext=new AsyncLocalStorage();
const sharedContext=new AsyncLocalStorage();

// The bounded lease remains on its separate pool while an ordinary business
// transaction can shadow the transaction ALS store. Only this private live
// callback marker identifies that enclosing, already acquired deployment lease.
export function requireProtectedRuntimeSharedExecutionScope(pool,scope) {
  const active=sharedContext.getStore();
  if (!active?.live || active.pool!==pool || !scope
    || Object.keys(scope).sort().join(',')!=='environment,securityEpoch'
    || active.environment!==scope.environment || active.securityEpoch!==scope.securityEpoch) {
    denied('PROTECTED_SHARED_EXECUTION_REQUIRED');
  }
  return true;
}

// Read-only assertion of the already acquired, deployment/owner-stamped scope.
// It cannot acquire a lease or turn an arbitrary business transaction into one.
export function requireProtectedSyntheticExecutionScope(pool,client,scope) {
  const active=syntheticContext.getStore();
  if (!active?.live || active.pool!==pool || active.client!==client || !scope
    || Object.keys(scope).sort().join(',')!=='environment,operatorId,operatorSecurityVersion,securityEpoch'
    || active.environment!==scope.environment || active.securityEpoch!==scope.securityEpoch
    || active.operatorId!==scope.operatorId || active.operatorSecurityVersion!==scope.operatorSecurityVersion
    || !isPostgresTransactionActive(pool,client)) denied('PROTECTED_SYNTHETIC_EXECUTION_REQUIRED');
  return true;
}

// These scopes coordinate database work; neither creates authentication, exact
// proof, target permission nor a reset grant. Composition must validate HTTP
// host/origin/body/rate boundaries first and provide current proof inside reset.
export function createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch }={}) {
  if (!poolPort(pool) || !poolPort(leasePool) || pool===leasePool || !['dev','int','prod'].includes(environment)
    || !isInternalUuid(securityEpoch)) throw new TypeError('PROTECTED_RUNTIME_EXECUTION_CONFIGURATION_INVALID');
  const epoch=securityEpoch.toLowerCase();
  async function requireDeployment(client,exclusive) {
    const result=await client.query({
      text: exclusive
        ? 'SELECT security_epoch FROM protected_runtime_deployments WHERE environment=$1 AND security_epoch=$2 FOR UPDATE'
        : 'SELECT security_epoch FROM protected_runtime_deployments WHERE environment=$1 AND security_epoch=$2',
      values: [environment,epoch],
    });
    if (result.rowCount!==1) denied('PROTECTED_RUNTIME_SCOPE_STALE');
  }
  function beforeScope(work) {
    if (typeof work!=='function') throw new TypeError('PROTECTED_RUNTIME_WORK_REQUIRED');
    if (isPostgresTransactionActive(pool)) denied('PROTECTED_RUNTIME_GATE_ORDER_INVALID');
  }
  return Object.freeze({
    withShared(work) {
      beforeScope(work);
      // The lease owns a separate bounded pool. Normal pool.query calls and RR
      // proof transactions can use the business pool even with max=1 on each.
      // Every business snapshot starts after the shared reset barrier is held.
      return withProtectedRuntimeSharedGate(leasePool,environment,async client=>{
        await requireDeployment(client,false);
        const active={ live: true,pool,environment,securityEpoch: epoch };
        return sharedContext.run(active,async()=>{
          try { return await work(); } finally { active.live=false; }
        });
      });
    },
    withSyntheticExclusive(scope,work) {
      beforeScope(work);
      if (environment==='prod' || !scope || Object.keys(scope).sort().join(',')!=='operatorId,operatorSecurityVersion'
        || !isInternalUuid(scope.operatorId) || !Number.isSafeInteger(scope.operatorSecurityVersion)
        || scope.operatorSecurityVersion<1) throw new TypeError('PROTECTED_SYNTHETIC_EXECUTION_SCOPE_INVALID');
      return withProtectedRuntimeRepeatableExclusiveGate(pool,environment,async client=>{
        await requireDeployment(client,true);
        // Lock and stamp the actual owner before reading its generation set.
        // Under RR an intervening own reset changes this tuple, producing40001
        // rather than missing a newly committed active generation/quota entry.
        // Trigger029 preserves SV when only updated_at changes. Failed proof or
        // mutation retains the proof repository's normal commit/rollback rules.
        const actor=await client.query({ text: `UPDATE platform_operators SET updated_at=clock_timestamp()
          WHERE id=$1 AND security_version=$2 AND provider=$3 AND status='active' RETURNING id`,
        values: [scope.operatorId,scope.operatorSecurityVersion,PLATFORM_ENTRA_PROVIDER] });
        if (actor.rowCount!==1) denied('PROTECTED_OPERATOR_SCOPE_STALE');
        const active={ live: true,pool,client,environment,securityEpoch: epoch,
          operatorId: scope.operatorId.toLowerCase(),operatorSecurityVersion: scope.operatorSecurityVersion };
        return syntheticContext.run(active,async()=>{
          try { return await work(client); } finally { active.live=false; }
        });
      });
    },
  });
}
