import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { requireProtectedTenantRuntime } from '../../tenancy/protected-tenant-runtime.js';
import { withProtectedRuntimeSharedGate } from './protected-runtime-gate.js';

export function createPostgresProtectedTenantRuntimeRepository(pool,{ environment,securityEpoch }={}) {
  if (!pool || typeof pool.query!=='function' || typeof pool.connect!=='function'
    || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_TENANT_RUNTIME_REPOSITORY_CONFIGURATION_INVALID');
  }
  async function current(client,tenantId) {
    if (!isInternalUuid(tenantId)) throw new TypeError('PROTECTED_TENANT_RUNTIME_SCOPE_INVALID');
    const result=await client.query({ name: 'protected-tenant-current-runtime',text: `SELECT registry.mode,
        registry.generation_id,registry.operator_id,registry.slot,generation.state AS generation_state
      FROM tenant_runtime_registry registry JOIN protected_runtime_deployments deployment
        ON deployment.environment=registry.environment AND deployment.security_epoch=$3
      JOIN tenants tenant ON tenant.id=registry.tenant_id
      LEFT JOIN synthetic_tenant_generations generation ON generation.environment=registry.environment
        AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
      LEFT JOIN platform_operators actor ON actor.id=registry.operator_id
      WHERE registry.environment=$1 AND registry.tenant_id=$2 AND tenant.status IN ('pending','onboarding','ready','active')
        AND (registry.mode='real' OR (registry.mode='synthetic' AND generation.state='active'
          AND generation.security_epoch=$3 AND actor.provider=$4 AND actor.status='active'
          AND actor.security_version=generation.operator_security_version)) LIMIT 1`,
    values: [environment,tenantId,securityEpoch,PLATFORM_ENTRA_PROVIDER] });
    const row=result.rows[0];if (!row) return null;
    return requireProtectedTenantRuntime({ environment,tenantId,securityEpoch },{ environment,tenantId,securityEpoch,
      mode: row.mode,generationId: row.generation_id,generationState: row.generation_state,operatorId: row.operator_id,slot: row.slot });
  }
  return Object.freeze({
    findCurrent(tenantId) {
      return withProtectedRuntimeSharedGate(pool,environment,client=>current(client,tenantId));
    },
    withCurrentTenantRuntime(scope,work) {
      if (!scope || typeof scope!=='object' || Array.isArray(scope)
        || Object.keys(scope).sort().join(',')!=='environment,securityEpoch,tenantId'
        || scope.environment!==environment || scope.securityEpoch!==securityEpoch || typeof work!=='function') {
        throw new TypeError('PROTECTED_TENANT_RUNTIME_SCOPE_INVALID');
      }
      return withProtectedRuntimeSharedGate(pool,environment,async client=>work(await current(client,scope.tenantId)));
    },
  });
}
