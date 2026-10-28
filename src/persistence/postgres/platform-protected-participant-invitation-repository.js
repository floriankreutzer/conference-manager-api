import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformOperationDeniedError } from '../../platform/application/platform-operation-errors.js';
import { isPostgresTransactionActive } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { createPostgresProtectedRealTenantScope } from './protected-real-tenant-scope.js';
import { createPostgresPlatformCustomerInvitationRepository } from './platform-customer-invitation-repository.js';

// Explicit DEV/INT composition only. The ordinary protected factory remains
// fixed REAL-only. Initial participant binding stays in the existing authorized
// Platform invitation transaction with its proof, receipt and both audit domains.
export function createPostgresProtectedParticipantPlatformInvitationRepository(pool,configuration={}) {
  const { environment,securityEpoch }=configuration;
  if (!['dev','int'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_SYNTHETIC_PARTICIPANT_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  const real=createPostgresProtectedRealTenantScope(pool,scope);
  function current(client,tenantId) {
    requireProtectedRuntimeSharedExecutionScope(pool,scope);
    if (!isPostgresTransactionActive(pool,client) || !isInternalUuid(tenantId)) {
      throw new TypeError('PROTECTED_SYNTHETIC_PARTICIPANT_TRANSACTION_INVALID');
    }
  }
  function actor(value) {
    if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return null;
    const keys=Reflect.ownKeys(value),field=Object.getOwnPropertyDescriptor(value,'operatorId');
    return keys.length===1 && keys[0]==='operatorId' && field?.enumerable && Object.hasOwn(field,'value')
      && isInternalUuid(field.value) ? field.value : null;
  }
  async function target(client,tenantId,context,admission) {
    current(client,tenantId);
    if (await real[admission ? 'lockAdmissionWithClient' : 'allowsWithClient'](client,tenantId)) return true;
    const operatorId=actor(context);if (operatorId===null) return false;
    const result=await client.query({
      name: admission ? 'platform-participant-target-admission' : 'platform-participant-target-read',
      text: `SELECT tenant.id FROM tenant_runtime_registry registry
        JOIN protected_runtime_deployments deployment ON deployment.environment=registry.environment AND deployment.security_epoch=$2
        JOIN synthetic_tenant_generations generation ON generation.environment=registry.environment
          AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
        JOIN platform_operators actor ON actor.id=generation.operator_id AND actor.security_version=generation.operator_security_version
        JOIN tenants tenant ON tenant.id=registry.tenant_id
        WHERE registry.environment=$1 AND registry.tenant_id=$3 AND registry.mode='synthetic' AND registry.operator_id=$4
          AND generation.state='active' AND generation.security_epoch=$2 AND actor.status='active'
          AND actor.provider='microsoft_entra_platform' AND tenant.status IN ('pending','onboarding','ready','active')
          FOR ${admission ? 'UPDATE' : 'SHARE'} OF tenant`,
      values: [environment,scope.securityEpoch,tenantId,operatorId] });
    return result.rowCount===1;
  }
  async function register(client,{ tenantId,invitationId,operatorId,now }) {
    current(client,tenantId);
    if (!isInternalUuid(invitationId) || !isInternalUuid(operatorId) || !(now instanceof Date)
      || !Number.isFinite(now.getTime())) throw new TypeError('PROTECTED_SYNTHETIC_PARTICIPANT_REGISTRATION_INVALID');
    if (await real.allowsWithClient(client,tenantId)) return true;
    const result=await client.query({ name: 'platform-participant-invitation-register',text: `
      INSERT INTO synthetic_invited_memberships(environment,tenant_id,membership_id,invitation_id,
        generation_id,operator_id,slot,created_at)
      SELECT registry.environment,registry.tenant_id,invitation.membership_id,invitation.id,
        registry.generation_id,registry.operator_id,registry.slot,$6
      FROM tenant_runtime_registry registry JOIN synthetic_tenant_generations generation
        ON generation.environment=registry.environment AND generation.id=registry.generation_id
          AND generation.operator_id=registry.operator_id
      JOIN customer_member_invitations invitation ON invitation.environment=registry.environment
        AND invitation.tenant_id=registry.tenant_id AND invitation.id=$4
      WHERE registry.environment=$1 AND registry.tenant_id=$3 AND registry.mode='synthetic' AND registry.operator_id=$5
        AND generation.state='active' AND generation.security_epoch=$2`,
    values: [environment,scope.securityEpoch,tenantId,invitationId,operatorId,now] });
    if (result.rowCount!==1) throw new PlatformOperationDeniedError();
    return true;
  }
  return createPostgresPlatformCustomerInvitationRepository(pool,{ ...configuration,
    tenantEligibility: Object.freeze({
      allowsWithClient: (client,tenantId,context)=>target(client,tenantId,context,false),
      lockAdmissionWithClient: (client,tenantId,context)=>target(client,tenantId,context,true),
    }),invitationCreatedWithClient: register,
  });
}
