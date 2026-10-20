import { isInternalUuid } from '../../domain/identifiers.js';
import { isPostgresTransactionActive } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

// Fixed REAL classification gate only. Ordinary current invitation/member/User/
// challenge eligibility is still checked by the canonical delivery repository.
export function createPostgresProtectedRealDeliveryEligibility(pool,{ environment,securityEpoch }={}) {
  if (!pool || typeof pool.connect!=='function' || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_DELIVERY_ELIGIBILITY_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  return Object.freeze({
    async allowsWithClient(client,tenantId) {
      requireProtectedRuntimeSharedExecutionScope(pool,scope);
      if (!isPostgresTransactionActive(pool,client) || !isInternalUuid(tenantId)) {
        throw new TypeError('PROTECTED_DELIVERY_ELIGIBILITY_TRANSACTION_INVALID');
      }
      const result=await client.query({ name: 'protected-delivery-real-tenant-lock',text: `SELECT tenant.id
        FROM tenant_runtime_registry registry JOIN protected_runtime_deployments deployment
          ON deployment.environment=registry.environment AND deployment.security_epoch=$2
        JOIN tenants tenant ON tenant.id=registry.tenant_id
        WHERE registry.environment=$1 AND registry.tenant_id=$3 AND registry.mode='real'
          AND registry.generation_id IS NULL AND registry.operator_id IS NULL AND registry.slot IS NULL
          AND tenant.status IN ('pending','onboarding','ready','active') FOR SHARE OF deployment,tenant`,
      values: [environment,scope.securityEpoch,tenantId] });
      return result.rowCount===1;
    },
  });
}
