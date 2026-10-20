import { isInternalUuid } from '../../domain/identifiers.js';
import { isPostgresTransactionActive } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

// Fixed REAL classification only; canonical repositories retain membership,
// invitation, proof and User eligibility. Admission takes the Tenant write lock
// immediately to avoid a shared-to-exclusive lock upgrade between admissions.
export function createPostgresProtectedRealTenantScope(pool,{ environment,securityEpoch }={}) {
  if (!pool || typeof pool.connect!=='function' || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_DELIVERY_ELIGIBILITY_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  async function qualified(client,tenantId,admission) {
      requireProtectedRuntimeSharedExecutionScope(pool,scope);
      if (!isPostgresTransactionActive(pool,client) || !isInternalUuid(tenantId)) {
        throw new TypeError('PROTECTED_DELIVERY_ELIGIBILITY_TRANSACTION_INVALID');
      }
      const locking=admission ? 'FOR SHARE OF deployment FOR UPDATE OF tenant' : 'FOR SHARE OF deployment,tenant';
      const result=await client.query({
        name: admission ? 'protected-admission-real-tenant-lock' : 'protected-delivery-real-tenant-lock',text: `SELECT tenant.id
        FROM tenant_runtime_registry registry JOIN protected_runtime_deployments deployment
          ON deployment.environment=registry.environment AND deployment.security_epoch=$2
        JOIN tenants tenant ON tenant.id=registry.tenant_id
        WHERE registry.environment=$1 AND registry.tenant_id=$3 AND registry.mode='real'
          AND registry.generation_id IS NULL AND registry.operator_id IS NULL AND registry.slot IS NULL
          AND tenant.status IN ('pending','onboarding','ready','active') ${locking}`,
      values: [environment,scope.securityEpoch,tenantId] });
      return result.rowCount===1;
  }
  return Object.freeze({
    allowsWithClient: (client,tenantId) => qualified(client,tenantId,false),
    lockAdmissionWithClient: (client,tenantId) => qualified(client,tenantId,true),
  });
}
