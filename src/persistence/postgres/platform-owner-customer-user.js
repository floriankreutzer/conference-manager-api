import { normalizeOwnerCustomerAccessScope,normalizeOwnerCustomerAccessSelection,ownerCustomerUserId }
  from '../../domain/owner-customer-handoff.js';
import { createOwnerCustomerAccessPolicy } from '../../platform/identity/owner-customer-access-policy.js';
import { AUDIT_ACTION,normalizeAuditEvent } from '../../audit/event.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { isPostgresTransactionActive } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

const deny=()=>{ throw new Error('OWNER_CUSTOMER_IDENTITY_DENIED'); };

// Stable own identity only. The deferred SQL guard requires this creation's
// exact approved owner flow at COMMIT. No role, suspension state or existing
// unrelated User is modified; the surrounding proof transaction owns approval.
export function createPostgresPlatformOwnerCustomerUser(pool,{ scope: rawScope,tenantAuditRepository }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope),policy=createOwnerCustomerAccessPolicy(scope);
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  if (typeof pool?.connect!=='function' || typeof tenantAuditRepository?.appendWithClient!=='function') {
    throw new TypeError('OWNER_CUSTOMER_IDENTITY_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    async currentOrCreateWithClient(client,{ principal: rawPrincipal,selection: rawSelection,time,correlationId }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('OWNER_CUSTOMER_IDENTITY_TRANSACTION_REQUIRED');
      const selection=normalizeOwnerCustomerAccessSelection(rawSelection),principal=policy.prepare(rawPrincipal,selection);
      if (!(time instanceof Date) || !Number.isFinite(time.getTime())) deny();
      const userId=ownerCustomerUserId({ environment: scope.environment,tenantId: selection.tenantId,operatorId: principal.operatorId });
      const binding=await client.query({ name: 'owner-customer-own-user-binding',text: `SELECT user_id,
          provider_tenant_reference,provider_subject_reference FROM platform_owner_customer_users
        WHERE environment=$1 AND operator_id=$2 AND tenant_id=$3 FOR SHARE`,
      values: [scope.environment,principal.operatorId,selection.tenantId] });
      if (binding.rowCount>1) deny();
      if (binding.rowCount===1) {
        const own=binding.rows[0];
        if (own.user_id!==userId || own.provider_tenant_reference!==principal.providerIdentity.tenantReference
          || own.provider_subject_reference!==principal.providerIdentity.subjectReference) deny();
        const current=await client.query({ name: 'owner-customer-current-own-user',text: `SELECT person.security_version
          FROM users person JOIN user_identity_bindings identity ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id
            AND identity.provider='platform_owner' AND identity.provider_tenant_reference=$3 AND identity.provider_user_reference=$4
          WHERE person.tenant_id=$1 AND person.id=$2 AND person.active=true
            AND NOT EXISTS(SELECT 1 FROM tenant_user_roles role WHERE role.tenant_id=person.tenant_id AND role.user_id=person.id)
          FOR SHARE OF person,identity`,values: [selection.tenantId,userId,principal.providerIdentity.tenantReference,
          principal.providerIdentity.subjectReference] });
        const version=Number(current.rows[0]?.security_version);
        if (current.rowCount!==1 || !Number.isSafeInteger(version) || version<1) deny();
        return Object.freeze({ userId,securityVersion: version,created: false });
      }
      // INSERT deliberately has no conflict/adoption/update path. An unbound
      // pre-existing predictable User ID or provider binding fails atomically.
      const created=await client.query({ name: 'owner-customer-own-user-create',text: `INSERT INTO users
        (tenant_id,id,display_name,created_at,updated_at) VALUES($1,$2,'Pavurel Owner',$3,$3) RETURNING security_version`,
      values: [selection.tenantId,userId,time] });
      if (created.rowCount!==1 || Number(created.rows[0].security_version)!==1) deny();
      await client.query({ name: 'owner-customer-own-provider-binding-create',text: `INSERT INTO user_identity_bindings
        (tenant_id,provider,provider_tenant_reference,provider_user_reference,user_id,created_at,updated_at)
        VALUES($1,'platform_owner',$2,$3,$4,$5,$5)`,values: [selection.tenantId,principal.providerIdentity.tenantReference,
        principal.providerIdentity.subjectReference,userId,time] });
      const event=normalizeAuditEvent({ tenantId: selection.tenantId,actorUserId: null,action: AUDIT_ACTION.TENANT_USER_PROVISIONED,
        targetType: 'user',targetId: userId,previousState: null,newState: { active: true,identityKind: 'platform_owner' },
        occurredAt: time.toISOString(),correlationId,outcome: 'success',
        metadata: { provider: 'platform_owner',operation: 'own_user_create' },
        retentionClass: 'administrative' });
      const stored=await tenantAuditRepository.appendWithClient(client,event);
      if (!stored || stored.tenantId!==selection.tenantId) throw new Error('TENANT_AUDIT_APPEND_FAILED');
      return Object.freeze({ userId,securityVersion: 1,created: true });
    },
    async bindCreatedWithClient(client,{ principal: rawPrincipal,selection: rawSelection,time,proofId,auditSequence,operationHash }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('OWNER_CUSTOMER_IDENTITY_TRANSACTION_REQUIRED');
      const selection=normalizeOwnerCustomerAccessSelection(rawSelection),principal=policy.prepare(rawPrincipal,selection);
      if (!(time instanceof Date) || !Number.isFinite(time.getTime()) || !isInternalUuid(proofId)
        || !/^[1-9]\d{0,18}$/.test(String(auditSequence)) || !/^[a-f0-9]{64}$/.test(operationHash ?? '')) deny();
      const userId=ownerCustomerUserId({ environment: scope.environment,tenantId: selection.tenantId,operatorId: principal.operatorId });
      // Called only after the ordinary Tenant audit then Platform audit append.
      // Deferred SQL admission validates the complete final exact approval.
      await client.query({ name: 'owner-customer-stable-attribution-create',text: `INSERT INTO platform_owner_customer_users
        (environment,operator_id,tenant_id,user_id,provider_tenant_reference,provider_subject_reference,created_flow_id,
          created_proof_id,created_audit_sequence,created_operation_hash,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,values: [scope.environment,principal.operatorId,selection.tenantId,userId,
        principal.providerIdentity.tenantReference,principal.providerIdentity.subjectReference,selection.flowId,
        proofId,String(auditSequence),operationHash,time] });
    },
  });
}
