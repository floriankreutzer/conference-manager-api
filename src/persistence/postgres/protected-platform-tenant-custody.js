import { isInternalUuid } from '../../domain/identifiers.js';

function parameter(value) {
  if (!Number.isSafeInteger(value) || value<1 || value>100) throw new TypeError('PROTECTED_PLATFORM_CUSTODY_PARAMETER_INVALID');
  return `$${value}`;
}

// Fixed server configuration intersects canonical target rights before SQL
// pagination. REAL allowlists remain canonical; live own synthetic targets use
// explicit current ownership, never another operator's all-Tenant scope.
export function createProtectedPlatformTenantCustodySql(scope=null) {
  if (scope===null) return null;
  const keys=['environment','securityEpoch'];
  if (!scope || Object.getPrototypeOf(scope)!==Object.prototype || Reflect.ownKeys(scope).length!==2
    || Reflect.ownKeys(scope).some(key=>!keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(scope,key),'value'))
    || !['dev','int','prod'].includes(scope.environment) || !isInternalUuid(scope.securityEpoch)) {
    throw new TypeError('PROTECTED_PLATFORM_CUSTODY_CONFIGURATION_INVALID');
  }
  const environment=scope.environment,securityEpoch=scope.securityEpoch.toLowerCase();
  return Object.freeze({
    cursorScope: Object.freeze({ environment,securityEpoch }),
    predicate({ tenant,operatorParameter=1,securityVersionParameter=2,modeParameter=null,firstParameter }={}) {
      if (typeof tenant!=='string' || !/^(?:[a-z][a-z0-9_]{0,31}\.id|\$[1-9]\d?)$/.test(tenant)) {
        throw new TypeError('PROTECTED_PLATFORM_CUSTODY_TENANT_INVALID');
      }
      const actor=parameter(operatorParameter),version=parameter(securityVersionParameter);
      const env=parameter(firstParameter),epoch=parameter(firstParameter+1);
      const mode=modeParameter===null ? null : parameter(modeParameter);
      function query(syntheticOnly) { return `EXISTS (
          SELECT 1 FROM tenant_runtime_registry protected_registry
          JOIN protected_runtime_deployments protected_deployment
            ON protected_deployment.environment=protected_registry.environment AND protected_deployment.security_epoch=${epoch}::uuid
          LEFT JOIN synthetic_tenant_generations protected_generation
            ON protected_generation.environment=protected_registry.environment
              AND protected_generation.id=protected_registry.generation_id
              AND protected_generation.operator_id=protected_registry.operator_id
          WHERE protected_registry.environment=${env} AND protected_registry.tenant_id=${tenant}
            AND ((${syntheticOnly ? 'false' : `protected_registry.mode='real' AND protected_registry.generation_id IS NULL
              AND protected_registry.operator_id IS NULL AND protected_registry.slot IS NULL`}) OR (
              protected_registry.mode='synthetic' AND ${env}<>'prod'
              AND protected_registry.operator_id=${actor}::uuid
              AND protected_registry.slot IN ('northwind','contoso','fabrikam')
              AND protected_generation.state='active' AND protected_generation.security_epoch=${epoch}::uuid
              AND protected_generation.operator_security_version=${version}
              AND EXISTS (SELECT 1 FROM platform_operators protected_actor
                WHERE protected_actor.id=${actor}::uuid AND protected_actor.status='active'
                  AND protected_actor.provider='microsoft_entra_platform' AND protected_actor.security_version=${version}
                  ${mode ? `AND protected_actor.scope_mode=${mode}` : ''})
              AND EXISTS (SELECT 1 FROM tenants protected_tenant
                WHERE protected_tenant.id=protected_registry.tenant_id AND protected_tenant.status IN ('onboarding','ready','active'))
            ))
        )`; }
      return Object.freeze({ values: Object.freeze([environment,securityEpoch]),
        deploymentSql: `EXISTS (SELECT 1 FROM protected_runtime_deployments protected_deployment
          WHERE protected_deployment.environment=${env} AND protected_deployment.security_epoch=${epoch}::uuid)`,
        sql: query(false),syntheticSql: query(true) });
    },
  });
}
