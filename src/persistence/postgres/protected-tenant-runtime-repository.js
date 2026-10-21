import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { requireProtectedTenantRuntime } from '../../tenancy/protected-tenant-runtime.js';
import { withProtectedRuntimeSharedGate } from './protected-runtime-gate.js';
import { createPostgresProtectedRuntimeExecutionScopes } from './protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from './transaction.js';

export function createPostgresProtectedTenantRuntimeRepository(pool,{ environment,securityEpoch,leasePool=null }={}) {
  if (!pool || typeof pool.query!=='function' || typeof pool.connect!=='function'
    || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_TENANT_RUNTIME_REPOSITORY_CONFIGURATION_INVALID');
  }
  // The owned protected composition supplies distinct bounded pools. The
  // legacy port remains for existing closed component consumers; malformed
  // explicit lease configuration never silently falls back to that port.
  const scopes=leasePool===null ? null
    : createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch });
  async function withCurrent(tenantId,work,cleanup=false) {
    if (scopes) return scopes.withShared(async()=>{
      const runtime=await withPostgresTransaction(pool,client=>current(client,tenantId,cleanup),{ readOnly: true });
      // Classification is fresh under the retained reset barrier; release the
      // short business read before provider work needs its own max1 connection.
      return work(runtime);
    });
    return withProtectedRuntimeSharedGate(pool,environment,async client=>work(await current(client,tenantId,cleanup)));
  }
  async function current(client,tenantId,cleanup) {
    if (!isInternalUuid(tenantId)) throw new TypeError('PROTECTED_TENANT_RUNTIME_SCOPE_INVALID');
    const result=await client.query({ name: 'protected-tenant-current-runtime',text: `SELECT registry.mode,
        registry.generation_id,registry.operator_id,registry.slot,generation.state AS generation_state
      FROM tenant_runtime_registry registry JOIN protected_runtime_deployments deployment
        ON deployment.environment=registry.environment AND deployment.security_epoch=$3
      JOIN tenants tenant ON tenant.id=registry.tenant_id
      LEFT JOIN synthetic_tenant_generations generation ON generation.environment=registry.environment
        AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
      LEFT JOIN platform_operators actor ON actor.id=registry.operator_id
      WHERE registry.environment=$1 AND registry.tenant_id=$2 AND (tenant.status IN ('pending','onboarding','ready','active')
          OR ($5::boolean AND registry.mode='real' AND tenant.status IN ('suspended','archived')))
        AND (registry.mode='real' OR (registry.mode='synthetic' AND generation.state='active'
          AND generation.security_epoch=$3 AND actor.provider=$4 AND actor.status='active'
          AND actor.security_version=generation.operator_security_version)) LIMIT 1`,
    values: [environment,tenantId,securityEpoch,PLATFORM_ENTRA_PROVIDER,cleanup] });
    const row=result.rows[0];if (!row) return null;
    return requireProtectedTenantRuntime({ environment,tenantId,securityEpoch },{ environment,tenantId,securityEpoch,
      mode: row.mode,generationId: row.generation_id,generationState: row.generation_state,operatorId: row.operator_id,slot: row.slot });
  }
  function qualified(scope,work,cleanup) {
      if (!scope || typeof scope!=='object' || Array.isArray(scope)
        || Object.keys(scope).sort().join(',')!=='environment,securityEpoch,tenantId'
        || scope.environment!==environment || scope.securityEpoch!==securityEpoch || typeof work!=='function') {
        throw new TypeError('PROTECTED_TENANT_RUNTIME_SCOPE_INVALID');
      }
      return withCurrent(scope.tenantId,work,cleanup);
  }
  return Object.freeze({
    findCurrent(tenantId) { return withCurrent(tenantId,value=>value); },
    withCurrentTenantRuntime: (scope,work)=>qualified(scope,work,false),
    // Provider cancellation only; this does not authorize a Customer or mutation.
    withCurrentTenantCleanupRuntime: (scope,work)=>qualified(scope,work,true),
  });
}
