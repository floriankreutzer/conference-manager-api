import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizeSyntheticHandoffScope,normalizeSyntheticHandoffSelection,syntheticHandoffOperationHash,
  SYNTHETIC_HANDOFF_CODE_SECONDS,SYNTHETIC_HANDOFF_RETAINED_OWNER_LIMIT } from '../../domain/synthetic-handoff.js';
import { normalizePlatformPrincipal } from '../../platform/identity/principal.js';
import { PLATFORM_PERMISSION } from '../../platform/identity/policy.js';
import { PLATFORM_AUDIT_ACTION,normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope,requireProtectedSyntheticExecutionScope }
  from './protected-runtime-execution-scopes.js';

const HASH=/^[a-f0-9]{64}$/;
function denied(code='SYNTHETIC_HANDOFF_DENIED') { throw new Error(code); }
function uuid(value) { if (!isInternalUuid(value)) denied();return value.toLowerCase(); }
function instant(value) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) denied();return value; }

// Private exact-proof Platform approval, separate from anonymous start custody.
// No method creates a Customer session. The private root owns cryptography,
// current execution scopes and the approving browser's final redirect.
export function createPostgresSyntheticHandoffRepository(pool,{ scope,browserBinding,platformAuditRepository }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  if (typeof pool?.connect!=='function' || typeof pool?.query!=='function'
    || typeof browserBinding?.issueCode!=='function'
    || typeof platformAuditRepository?.appendWithClient!=='function') {
    throw new TypeError('SYNTHETIC_HANDOFF_REPOSITORY_CONFIGURATION_INVALID');
  }
  const protection=Object.freeze({ environment: scope.environment,securityEpoch: scope.securityEpoch });
  const fixed=[scope.environment,scope.securityEpoch,scope.platformSecurityEpoch,scope.customerOrigin,scope.platformOrigin];
  async function now(client) { return instant((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now); }
  async function flow(client,flowId,stateHash,lock=false) {
    flowId=uuid(flowId);if (typeof stateHash!=='string' || !HASH.test(stateHash)) denied();
    const result=await client.query({ name: lock ? 'synthetic-handoff-pending-lock' : 'synthetic-handoff-pending-read',
      text: `SELECT custody.*
      FROM synthetic_customer_handoffs custody JOIN protected_runtime_deployments deployment
        ON deployment.environment=custody.environment AND deployment.security_epoch=custody.security_epoch
      WHERE custody.environment=$1 AND custody.security_epoch=$2 AND custody.platform_security_epoch=$3
        AND custody.customer_origin=$4 AND custody.platform_origin=$5 AND custody.id=$6 AND custody.state_hash=$7
        AND custody.status='pending' AND custody.expires_at>clock_timestamp() ${lock ? 'FOR UPDATE OF custody' : ''}`,
    values: [...fixed,flowId,stateHash] });
    return result.rows[0] ?? null;
  }
  function binding(value) {
    return value ? Object.freeze({ flowId: value.id,stateHash: value.state_hash,browserVerifier: value.browser_verifier }) : null;
  }
  async function currentSelection(client,principal,selection) {
    principal=normalizePlatformPrincipal(principal);
    if (principal.operatorId!==selection.operatorId || principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER
      || principal.assurance.level!=='mfa' || principal.assurance.authenticationContext!=='cm:pk:v1'
      || principal.session.securityEpoch!==scope.platformSecurityEpoch) denied();
    const result=await client.query({ name: 'synthetic-handoff-current-selection',text: `SELECT registry.tenant_id,person.id AS user_id,
        person.security_version,clock_timestamp() AS now
      FROM platform_operators actor JOIN platform_sessions source ON source.operator_id=actor.id
      JOIN protected_runtime_deployments deployment ON deployment.environment=$1 AND deployment.security_epoch=$2
      JOIN synthetic_tenant_generations generation ON generation.environment=deployment.environment
        AND generation.id=$7 AND generation.operator_id=actor.id AND generation.security_epoch=deployment.security_epoch
      JOIN tenant_runtime_registry registry ON registry.environment=generation.environment AND registry.generation_id=generation.id
        AND registry.operator_id=actor.id AND registry.slot=$8 AND registry.mode='synthetic'
      JOIN tenants tenant ON tenant.id=registry.tenant_id
      JOIN user_identity_bindings identity ON identity.tenant_id=tenant.id AND identity.provider='platform_delegation'
        AND identity.provider_tenant_reference=generation.id::text AND identity.provider_user_reference=actor.id::text||':'||$9
      JOIN users person ON person.tenant_id=tenant.id AND person.id=identity.user_id
      WHERE actor.id=$3::uuid AND actor.security_version=$4 AND actor.status='active' AND actor.provider=$16
        AND actor.provider_tenant_reference=$13 AND actor.provider_subject_reference=$14 AND actor.roles=$10::text[]
        AND actor.scope_mode=$12 AND generation.operator_security_version=actor.security_version AND generation.state='active'
        AND tenant.status IN ('onboarding','ready','active') AND person.active=true
        AND source.id=$6 AND source.principal_version=actor.security_version AND source.security_epoch=$5
        AND source.provider=actor.provider AND source.provider_tenant_reference=actor.provider_tenant_reference
        AND source.provider_subject_reference=actor.provider_subject_reference AND source.roles=actor.roles
        AND source.scope_mode=actor.scope_mode AND source.permissions=$11::text[] AND $17=ANY(source.permissions)
        AND source.assurance_level='mfa' AND source.authentication_context='cm:pk:v1' AND source.authenticated_at=$15
        AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp() AND source.issued_at<=clock_timestamp()+interval '1 minute'
        AND (SELECT count(*) FROM platform_passkey_credentials key
          WHERE key.operator_id=actor.id AND key.environment=$1 AND key.revoked_at IS NULL)>=2
        AND NOT EXISTS(SELECT 1 FROM tenant_user_roles elevation WHERE elevation.tenant_id=person.tenant_id
          AND elevation.user_id=person.id AND elevation.role<>$9)
        AND (($9='employee' AND NOT EXISTS(SELECT 1 FROM tenant_user_roles elevation
            WHERE elevation.tenant_id=person.tenant_id AND elevation.user_id=person.id))
          OR ($9<>'employee' AND EXISTS(SELECT 1 FROM tenant_user_roles elevation
            WHERE elevation.tenant_id=person.tenant_id AND elevation.user_id=person.id AND elevation.role=$9)))
      FOR SHARE OF actor,source,deployment,generation,registry,tenant,person,identity`,
    values: [scope.environment,scope.securityEpoch,principal.operatorId,principal.securityVersion,scope.platformSecurityEpoch,
      principal.session.id,selection.generationId,selection.slot,selection.role,principal.roles,principal.permissions,
      principal.targetScope.mode,principal.providerIdentity.tenantReference,principal.providerIdentity.subjectReference,
      principal.assurance.authenticatedAt,PLATFORM_ENTRA_PROVIDER,PLATFORM_PERMISSION.LIFECYCLE_MANAGE] });
    if (result.rowCount!==1) denied();
    const row=result.rows[0],version=Number(row.security_version);
    instant(row.now);uuid(row.tenant_id);uuid(row.user_id);
    if (!Number.isSafeInteger(version) || version<1) denied();
    return row;
  }
  return Object.freeze({
    async binding({ flowId,stateHash }={}) {
      // Preauthentication metadata proves no operator or generation authority.
      // Possession is bound to the opaque state MAC and current fixed deployment.
      return withPostgresTransaction(pool,async client=>binding(await flow(client,flowId,stateHash)));
    },
    async prepare({ principal,selection: value,stateHash }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);const selection=normalizeSyntheticHandoffSelection(value);
      return withPostgresTransaction(pool,async client=>{
        await currentSelection(client,principal,selection);return binding(await flow(client,selection.flowId,stateHash));
      });
    },
    async approve({ principal: rawPrincipal,continuationPrincipal: rawFuture,selection: value,stateHash,
      expectedBinding,operationHash,correlationId }={}) {
      const principal=normalizePlatformPrincipal(rawPrincipal),future=normalizePlatformPrincipal(rawFuture);
      const selection=normalizeSyntheticHandoffSelection(value);correlationId=uuid(correlationId);
      if (principal.operatorId!==selection.operatorId || future.operatorId!==principal.operatorId
        || future.securityVersion!==principal.securityVersion || principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER
        || principal.assurance.level!=='step_up' || principal.assurance.authenticationContext!=='cm:pk:v1'
        || principal.assurance.authenticatedAt!==future.assurance.authenticatedAt || principal.session.id===future.session.id
        || principal.session.securityEpoch!==scope.platformSecurityEpoch) denied();
      return withPostgresTransaction(pool,async client=>{
        requireProtectedSyntheticExecutionScope(pool,client,{ ...protection,operatorId: principal.operatorId,
          operatorSecurityVersion: principal.securityVersion });
        const current=await currentSelection(client,future,selection);
        const row=await flow(client,selection.flowId,stateHash,true);
        if (!row || syntheticHandoffOperationHash(scope,selection,expectedBinding)!==operationHash
          || syntheticHandoffOperationHash(scope,selection,binding(row))!==operationHash) denied();
        const time=await now(client),expiresAt=new Date(Math.min(instant(row.expires_at).getTime(),
          time.getTime()+SYNTHETIC_HANDOFF_CODE_SECONDS*1000));
        if (expiresAt<=time) denied();
        const proof=await client.query({ name: 'synthetic-handoff-current-consumed-proof',text: `SELECT id
          FROM platform_passkey_auth_transactions WHERE environment=$1 AND security_epoch=$2 AND operator_id=$3
            AND operator_security_version=$4 AND purpose='step_up' AND operation_hash=$5 AND expected_session_id<>$6
            AND consumed_at IS NOT NULL AND consumed_at<expires_at AND date_trunc('milliseconds',consumed_at)=$7
          ORDER BY id LIMIT 2 FOR SHARE`,values: [scope.environment,scope.platformSecurityEpoch,principal.operatorId,
          principal.securityVersion,operationHash,future.session.id,future.assurance.authenticatedAt] });
        if (proof.rowCount!==1) denied();
        const free=await client.query({ name: 'synthetic-handoff-owner-free-slot',text: `SELECT candidate.slot
          FROM generate_series(1,$3::integer) AS candidate(slot) WHERE NOT EXISTS(SELECT 1 FROM synthetic_customer_handoffs custody
            WHERE custody.environment=$1 AND custody.operator_id=$2 AND custody.owner_slot=candidate.slot)
          ORDER BY candidate.slot LIMIT 1`,values: [scope.environment,principal.operatorId,SYNTHETIC_HANDOFF_RETAINED_OWNER_LIMIT] });
        if (free.rowCount!==1) denied('SYNTHETIC_HANDOFF_OWNER_CAPACITY');
        const approval=browserBinding.issueCode(selection.flowId);
        const event=normalizePlatformAuditEvent({ operatorId: principal.operatorId,roles: principal.roles,
          permissions: principal.permissions,assuranceLevel: principal.assurance.level,targetTenantId: current.tenant_id,
          action: PLATFORM_AUDIT_ACTION.SYNTHETIC_ACCESS_APPROVED,targetType: 'synthetic_access',targetId: current.tenant_id,
          previousState: null,newState: null,metadata: { mode: 'synthetic',generationId: selection.generationId,
            slot: selection.slot,role: selection.role },occurredAt: time.toISOString(),correlationId,
          outcome: 'success',retentionClass: 'security' });
        const stored=await platformAuditRepository.appendWithClient(client,event,{ expectedTargetTenantId: current.tenant_id });
        if (!stored || stored.targetTenantId!==current.tenant_id || !/^[1-9]\d{0,18}$/.test(String(stored.sequence))) {
          denied('PLATFORM_AUDIT_APPEND_FAILED');
        }
        const updated=await client.query({ name: 'synthetic-handoff-approve',text: `UPDATE synthetic_customer_handoffs
          SET status='approved',owner_slot=$3,
          operator_id=$4,operator_security_version=$5,generation_id=$6,slot=$7,selected_role=$8,tenant_id=$9,user_id=$10,
          user_security_version=$11,source_platform_session_id=$12,approval_proof_id=$13,operation_hash=$14,
          approval_audit_sequence=$15,code_verifier=$16,approved_at=$17,code_expires_at=$18 WHERE environment=$1 AND id=$2 RETURNING id`,
        values: [scope.environment,selection.flowId,free.rows[0].slot,principal.operatorId,principal.securityVersion,
          selection.generationId,selection.slot,selection.role,current.tenant_id,current.user_id,Number(current.security_version),
          future.session.id,proof.rows[0].id,operationHash,String(stored.sequence),approval.codeVerifier,time,expiresAt] });
        if (updated.rowCount!==1 || updated.rows[0]?.id!==selection.flowId) denied('SYNTHETIC_HANDOFF_APPROVAL_FAILED');
        // Raw code stays only in the callback result. The HTTP root may redirect
        // only after the enclosing exact-proof transaction has committed.
        return Object.freeze({ status: 'approved',code: approval.code,expiresAt: expiresAt.toISOString() });
      },{ isolationLevel: 'REPEATABLE READ' });
    },
  });
}
