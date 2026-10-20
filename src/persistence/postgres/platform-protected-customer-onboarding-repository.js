import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { createPostgresPlatformCustomerOnboardingRepository } from './platform-customer-onboarding-repository.js';

// The ordinary proof/permission, owner-inclusive invitation custody and both
// audit domains stay authoritative. Classification is part of that SAME proof
// transaction, before any Tenant or outbox row can be observed after commit.
export function createPostgresProtectedPlatformCustomerOnboardingRepository(pool,configuration={}) {
  const { environment,securityEpoch }=configuration;
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_CUSTOMER_ONBOARDING_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  const ordinary=createPostgresPlatformCustomerOnboardingRepository(pool,configuration);
  return Object.freeze({
    async create(input) {
      requireProtectedRuntimeSharedExecutionScope(pool,scope);
      return withPostgresTransaction(pool,async client=>{
        const deployment=await client.query({ name: 'protected-customer-onboarding-deployment-lock',text: `SELECT environment
          FROM protected_runtime_deployments WHERE environment=$1 AND security_epoch=$2 FOR SHARE`,
        values: [environment,scope.securityEpoch] });
        if (deployment.rowCount!==1) throw new Error('PROTECTED_RUNTIME_SCOPE_STALE');
        const result=await ordinary.create(input);
        if (!result || !['updated','idempotent'].includes(result.outcome) || !isInternalUuid(result.tenant?.id)) {
          throw new Error('PROTECTED_CUSTOMER_ONBOARDING_RESULT_INVALID');
        }
        if (result.outcome==='updated') {
          await client.query({ name: 'protected-customer-onboarding-real-registry-insert',text: `INSERT INTO tenant_runtime_registry
            (environment,tenant_id,mode) VALUES($1,$2,'real')`,values: [environment,result.tenant.id] });
        }
        // A pre-existing receipt must already have its own exact immutable REAL
        // classification. Never retrofit an older/unclassified or synthetic row.
        const registered=await client.query({ name: 'protected-customer-onboarding-real-registry-read',text: `SELECT tenant_id
          FROM tenant_runtime_registry WHERE environment=$1 AND tenant_id=$2 AND mode='real'
            AND generation_id IS NULL AND operator_id IS NULL AND slot IS NULL`,values: [environment,result.tenant.id] });
        if (registered.rowCount!==1) throw new Error('PROTECTED_CUSTOMER_ONBOARDING_CLASSIFICATION_REQUIRED');
        return result;
      },{ isolationLevel: 'REPEATABLE READ' });
    },
  });
}
