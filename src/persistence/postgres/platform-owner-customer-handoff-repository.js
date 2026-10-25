import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeOwnerCustomerAccessScope,normalizeOwnerCustomerAccessSelection,ownerCustomerAccessOperationHash,
  OWNER_CUSTOMER_ACCESS_CODE_SECONDS,OWNER_CUSTOMER_ACCESS_RETAINED_OWNER_LIMIT } from '../../domain/owner-customer-handoff.js';
import { createOwnerCustomerAccessPolicy } from '../../platform/identity/owner-customer-access-policy.js';
import { PLATFORM_AUDIT_ACTION,normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { createPostgresOwnerCustomerSourceCustody } from './platform-owner-customer-source-custody.js';
import { createPostgresPlatformOwnerCustomerUser } from './platform-owner-customer-user.js';

const HASH=/^[a-f0-9]{64}$/;
const deny=(code='OWNER_HANDOFF_DENIED')=>{ throw new Error(code); };
function uuid(value) { if (!isInternalUuid(value)) deny();return value.toLowerCase(); }
function instant(value) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) deny();return value; }
function binding(row) {
  return row ? Object.freeze({ flowId: row.id,stateHash: row.state_hash,browserVerifier: row.browser_verifier }) : null;
}

// Private Platform half. It creates only the owner's own attributable identity
// and a one-use approval, never a Customer session. All writes join the actual
// consumed shared Microsoft proof/future normal-session transaction and audit.
export function createPostgresPlatformOwnerCustomerHandoffRepository(pool,{ scope: rawScope,browserBinding,
  platformAuditRepository,tenantAuditRepository }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope),policy=createOwnerCustomerAccessPolicy(scope);
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  if (typeof pool?.connect!=='function' || typeof pool?.query!=='function' || typeof browserBinding?.issueCode!=='function'
    || typeof platformAuditRepository?.appendWithClient!=='function') {
    throw new TypeError('OWNER_HANDOFF_REPOSITORY_CONFIGURATION_INVALID');
  }
  const source=createPostgresOwnerCustomerSourceCustody(pool,{ scope });
  const ownUser=createPostgresPlatformOwnerCustomerUser(pool,{ scope,tenantAuditRepository });
  const fixed=[scope.environment,scope.securityEpoch,scope.platformSecurityEpoch,scope.customerOrigin,scope.platformOrigin];
  async function flow(client,flowId,stateHash,lock=false) {
    flowId=uuid(flowId);if (typeof stateHash!=='string' || !HASH.test(stateHash)) deny();
    const result=await client.query({ name: lock ? 'owner-handoff-pending-lock' : 'owner-handoff-pending-read',text: `SELECT custody.*
      FROM owner_customer_handoffs custody JOIN protected_runtime_deployments deployment
        ON deployment.environment=custody.environment AND deployment.security_epoch=custody.security_epoch
      WHERE custody.environment=$1 AND custody.security_epoch=$2 AND custody.platform_security_epoch=$3
        AND custody.customer_origin=$4 AND custody.platform_origin=$5 AND custody.id=$6 AND custody.state_hash=$7
        AND custody.status='pending' AND custody.expires_at>clock_timestamp() ${lock ? 'FOR UPDATE OF custody' : ''}`,
    values: [...fixed,flowId,stateHash] });
    return result.rows[0] ?? null;
  }
  return Object.freeze({
    binding({ flowId,stateHash }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      return withPostgresTransaction(pool,async client=>binding(await flow(client,flowId,stateHash)));
    },
    prepare({ principal,selection: rawSelection,stateHash }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);const selection=normalizeOwnerCustomerAccessSelection(rawSelection);
      return withPostgresTransaction(pool,async client=>{
        if (!await source.currentWithClient(client,{ principal,selection })) deny();
        return binding(await flow(client,selection.flowId,stateHash));
      });
    },
    approve({ principal: rawPrincipal,continuationPrincipal: rawFuture,selection: rawSelection,stateHash,expectedBinding,
      operationHash,correlationId }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      const selection=normalizeOwnerCustomerAccessSelection(rawSelection);
      const { principal,continuationPrincipal: future }=policy.continuation(rawPrincipal,rawFuture,selection);
      correlationId=uuid(correlationId);
      return withPostgresTransaction(pool,async client=>{
        const current=await source.currentWithClient(client,{ principal: future,selection });if (!current) deny();
        const lock=await client.query({ name: 'owner-handoff-approval-lock',text: `SELECT pg_try_advisory_xact_lock(
          hashtext('owner-customer-approval-v1'),hashtext($1)) AS acquired`,values: [`${scope.environment}:${principal.operatorId}`] });
        if (lock.rows[0]?.acquired!==true) deny('OWNER_HANDOFF_BUSY');
        const row=await flow(client,selection.flowId,stateHash,true);
        if (!row || ownerCustomerAccessOperationHash(scope,selection,expectedBinding)!==operationHash
          || ownerCustomerAccessOperationHash(scope,selection,binding(row))!==operationHash) deny();
        const time=instant((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now);
        const expiresAt=new Date(Math.min(instant(row.expires_at).getTime(),Date.parse(current.sourceExpiresAt),
          time.getTime()+OWNER_CUSTOMER_ACCESS_CODE_SECONDS*1000));
        if (expiresAt<=time) deny();
        const proof=await client.query({ name: 'owner-handoff-consumed-shared-proof',text: `SELECT id
          FROM platform_microsoft_operation_proofs WHERE environment=$1 AND protected_security_epoch=$2 AND security_epoch=$3
            AND operator_id=$4 AND operator_security_version=$5 AND execution_scope='shared' AND status='consumed'
            AND operation_hash=$6 AND expected_session_id<>$7 AND authenticated_at=$8
            AND provider_tenant_reference::text=$9 AND provider_subject_reference::text=$10
            AND consumed_at IS NOT NULL AND consumed_at<expires_at
            AND $11>=date_trunc('milliseconds',consumed_at) AND $11<=date_trunc('milliseconds',consumed_at)+interval '30 seconds'
          ORDER BY id LIMIT 2 FOR SHARE`,values: [scope.environment,scope.securityEpoch,scope.platformSecurityEpoch,
          principal.operatorId,principal.securityVersion,operationHash,future.session.id,future.assurance.authenticatedAt,
          principal.providerIdentity.tenantReference,principal.providerIdentity.subjectReference,time] });
        if (proof.rowCount!==1) deny();
        const free=await client.query({ name: 'owner-handoff-owner-free-slot',text: `SELECT candidate.slot
          FROM generate_series(1,$3::integer) AS candidate(slot) WHERE NOT EXISTS(SELECT 1 FROM owner_customer_handoffs custody
            WHERE custody.environment=$1 AND custody.operator_id=$2 AND custody.owner_slot=candidate.slot)
          ORDER BY candidate.slot LIMIT 1`,values: [scope.environment,principal.operatorId,OWNER_CUSTOMER_ACCESS_RETAINED_OWNER_LIMIT] });
        if (free.rowCount!==1) deny('OWNER_HANDOFF_CAPACITY');
        const own=await ownUser.currentOrCreateWithClient(client,{ principal: future,selection,time,correlationId });
        const event=normalizePlatformAuditEvent({ operatorId: principal.operatorId,roles: principal.roles,
          permissions: principal.permissions,
          assuranceLevel: 'step_up',targetTenantId: selection.tenantId,action: PLATFORM_AUDIT_ACTION.OWNER_CUSTOMER_ACCESS_APPROVED,
          targetType: 'owner_customer_access',targetId: selection.tenantId,previousState: null,newState: null,
          occurredAt: time.toISOString(),correlationId,outcome: 'success',retentionClass: 'security',
          metadata: { mode: 'real',role: selection.role,userId: own.userId,ownIdentityCreated: own.created,flowId: selection.flowId } });
        const evidence=await platformAuditRepository.appendWithClient(client,event,{ expectedTargetTenantId: selection.tenantId });
        if (!evidence || evidence.targetTenantId!==selection.tenantId || !/^[1-9]\d{0,18}$/.test(String(evidence.sequence))) {
          deny('PLATFORM_AUDIT_APPEND_FAILED');
        }
        if (own.created) await ownUser.bindCreatedWithClient(client,{ principal: future,selection,time,
          proofId: proof.rows[0].id,auditSequence: evidence.sequence,operationHash });
        const approval=browserBinding.issueCode(selection.flowId);
        const updated=await client.query({ name: 'owner-handoff-approve',text: `UPDATE owner_customer_handoffs SET status='approved',
          owner_slot=$3,operator_id=$4,operator_security_version=$5,selected_role=$6,tenant_id=$7,user_id=$8,user_security_version=$9,
          identity_created=$10,source_platform_session_id=$11,approval_microsoft_proof_id=$12,operation_hash=$13,
          approval_audit_sequence=$14,code_verifier=$15,approved_at=$16,code_expires_at=$17
          WHERE environment=$1 AND id=$2 RETURNING id`,values: [scope.environment,selection.flowId,free.rows[0].slot,
          principal.operatorId,principal.securityVersion,selection.role,selection.tenantId,own.userId,own.securityVersion,own.created,
          future.session.id,proof.rows[0].id,operationHash,String(evidence.sequence),approval.codeVerifier,time,expiresAt] });
        if (updated.rowCount!==1 || updated.rows[0].id!==selection.flowId) deny();
        return Object.freeze({ status: 'approved',code: approval.code,expiresAt: expiresAt.toISOString() });
      });
    },
  });
}
