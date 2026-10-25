import { normalizeOwnerCustomerAccessScope,ownerCustomerAccessOperationHash,ownerCustomerUserId,
  ownerCustomerAccessIdentityReference } from '../../domain/owner-customer-handoff.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { requireProtectedTenantRuntime } from '../../tenancy/protected-tenant-runtime.js';
import { withPostgresTransaction,isPostgresTransactionActive } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

function sameSet(left,right) {
  return Array.isArray(left) && Array.isArray(right) && left.length===right.length && left.every(value=>right.includes(value));
}
function selection(row) {
  return { flowId: row.id,operatorId: row.operator_id,tenantId: row.tenant_id,role: row.selected_role };
}
function binding(row) { return { flowId: row.id,stateHash: row.state_hash,browserVerifier: row.browser_verifier }; }

// Current REAL owner custody only, after ordinary namespace-bound cookie
// resolution or original-browser/code possession. Creation attribution is not
// live authority: every access retains its own current normal Microsoft source.
export function createPostgresOwnerCustomerAccessRepository(pool,{ scope: rawScope }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope),protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  if (typeof pool?.query!=='function' || typeof pool?.connect!=='function') {
    throw new TypeError('OWNER_CUSTOMER_ACCESS_REPOSITORY_CONFIGURATION_INVALID');
  }
  const fixed=[scope.environment,scope.securityEpoch,scope.platformSecurityEpoch,scope.customerOrigin,scope.platformOrigin];
  async function current(client,flowId) {
    if (!isInternalUuid(flowId)) return null;
    const result=await client.query({ name: 'owner-customer-current-custody',text: `SELECT custody.*,
      source.expires_at AS source_expires_at,tenant.display_name AS tenant_display_name
    FROM owner_customer_handoffs custody
    JOIN public.tenant_runtime_registry registry ON registry.environment=custody.environment AND registry.tenant_id=custody.tenant_id
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=registry.environment
      AND deployment.security_epoch=custody.security_epoch
    JOIN public.tenants tenant ON tenant.id=registry.tenant_id
    JOIN public.platform_operators actor ON actor.id=custody.operator_id
    JOIN public.platform_owner_customer_users own ON own.environment=custody.environment AND own.operator_id=actor.id
      AND own.tenant_id=tenant.id AND own.user_id=custody.user_id
      AND own.provider_tenant_reference::text=actor.provider_tenant_reference
      AND own.provider_subject_reference::text=actor.provider_subject_reference
    JOIN public.users person ON person.tenant_id=tenant.id AND person.id=own.user_id
    JOIN public.user_identity_bindings identity ON identity.tenant_id=tenant.id AND identity.user_id=person.id
      AND identity.provider='platform_owner' AND identity.provider_tenant_reference=actor.provider_tenant_reference
      AND identity.provider_user_reference=actor.provider_subject_reference
    JOIN public.platform_audit_events bootstrap ON bootstrap.target_type='platform_operator_bootstrap'
      AND bootstrap.target_id=actor.id::text AND bootstrap.operator_id IS NULL
      AND bootstrap.action='platform.operator.changed' AND bootstrap.assurance_level='offline_owner'
      AND bootstrap.outcome='success' AND bootstrap.retention_class='recovery'
      AND bootstrap.metadata->>'operation'='first_owner_bootstrap' AND bootstrap.metadata->>'environment'=custody.environment
    JOIN public.platform_audit_events owner_roles ON owner_roles.target_type='platform_owner_roles'
      AND owner_roles.target_id=actor.id::text AND owner_roles.operator_id IS NULL
      AND owner_roles.action='platform.operator.changed' AND owner_roles.assurance_level='offline_owner'
      AND owner_roles.outcome='success' AND owner_roles.retention_class='recovery'
      AND owner_roles.metadata->>'operation'='owner_all_platform_roles' AND owner_roles.metadata->>'environment'=custody.environment
    JOIN public.platform_sessions source ON source.id=custody.source_platform_session_id AND source.operator_id=actor.id
    JOIN public.platform_microsoft_operation_proofs proof ON proof.id=custody.approval_microsoft_proof_id AND proof.operator_id=actor.id
    JOIN public.platform_audit_events evidence ON evidence.sequence=custody.approval_audit_sequence AND evidence.operator_id=actor.id
    WHERE registry.environment=custody.environment AND registry.tenant_id=custody.tenant_id AND registry.mode='real'
      AND actor.provider='microsoft_entra_platform' AND actor.status='active' AND actor.security_version=custody.operator_security_version
      AND actor.scope_mode='all' AND actor.roles=ARRAY[
        'platform_security_admin','platform_security_auditor','platform_support_reader','platform_tenant_operator']::text[]
      AND (SELECT count(*) FROM public.platform_audit_events WHERE target_type='platform_operator_bootstrap')=1
      AND (SELECT count(*) FROM public.platform_audit_events WHERE target_type='platform_owner_roles')=1
      AND tenant.status IN ('pending','onboarding','ready','active') AND person.active=true
      AND person.security_version=custody.user_security_version
      AND NOT EXISTS(SELECT 1 FROM public.tenant_user_roles elevation
        WHERE elevation.tenant_id=person.tenant_id AND elevation.user_id=person.id)
      AND source.provider=actor.provider AND source.provider_tenant_reference=actor.provider_tenant_reference
      AND source.provider_subject_reference=actor.provider_subject_reference AND source.principal_version=actor.security_version
      AND source.roles=actor.roles AND source.scope_mode=actor.scope_mode AND 'platform:operator:manage'=ANY(source.permissions)
      AND source.assurance_level='mfa' AND source.authentication_context='cm:ms:mfa:v1' AND source.step_up_expires_at IS NULL
      AND source.security_epoch=custody.platform_security_epoch AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp()
      AND source.issued_at<=clock_timestamp()+interval '1 minute'
      AND proof.environment=custody.environment AND proof.protected_security_epoch=custody.security_epoch
      AND proof.security_epoch=custody.platform_security_epoch AND proof.operator_security_version=custody.operator_security_version
      AND proof.execution_scope='shared' AND proof.status='consumed' AND proof.operation_hash=custody.operation_hash
      AND proof.provider_tenant_reference::text=actor.provider_tenant_reference
      AND proof.provider_subject_reference::text=actor.provider_subject_reference AND proof.expected_session_id<>source.id
      AND proof.consumed_at IS NOT NULL AND proof.consumed_at<proof.expires_at AND proof.authenticated_at=source.authenticated_at
      AND custody.approved_at>=date_trunc('milliseconds',proof.consumed_at)
      AND custody.approved_at<=date_trunc('milliseconds',proof.consumed_at)+interval '30 seconds'
      AND evidence.action='platform.owner_customer_access.approved' AND evidence.target_tenant_id=tenant.id
      AND evidence.target_type='owner_customer_access' AND evidence.target_id=tenant.id::text
      AND evidence.outcome='success' AND evidence.assurance_level='step_up' AND evidence.roles=actor.roles
      AND evidence.permissions=source.permissions AND evidence.metadata=jsonb_build_object('mode','real','role',custody.selected_role,
        'userId',person.id::text,'ownIdentityCreated',custody.identity_created,'flowId',custody.id::text)
      AND (NOT custody.identity_created OR (own.created_flow_id=custody.id AND own.created_at=custody.approved_at
        AND own.created_proof_id=custody.approval_microsoft_proof_id AND own.created_audit_sequence=custody.approval_audit_sequence
        AND own.created_operation_hash=custody.operation_hash AND person.created_at=own.created_at AND identity.created_at=own.created_at))
      AND custody.environment=$1 AND custody.security_epoch=$2 AND custody.platform_security_epoch=$3
      AND custody.customer_origin=$4 AND custody.platform_origin=$5 AND custody.id=$6
      AND custody.status IN ('approved','consumed') LIMIT 1`,values: [...fixed,flowId] });
    if (result.rowCount!==1) return null;const row=result.rows[0];
    try {
      if (ownerCustomerAccessOperationHash(scope,selection(row),binding(row))!==row.operation_hash
        || ownerCustomerUserId({ environment: scope.environment,tenantId: row.tenant_id,operatorId: row.operator_id })!==row.user_id
        || !Number.isSafeInteger(Number(row.user_security_version)) || Number(row.user_security_version)<1) return null;
    } catch { return null; }
    return row;
  }
  async function resolve(client,input) {
    if (!input || Object.keys(input).sort().join(',')!=='environment,principal,securityEpoch'
      || input.environment!==scope.environment || input.securityEpoch!==scope.securityEpoch) return null;
    let principal;try { principal=normalizePrincipal(input.principal); } catch { return null; }
    if (principal.providerIdentity.provider!=='platform_owner') return null;
    const result=await client.query({ name: 'owner-customer-session-custody',text: `SELECT custody.id
      FROM owner_customer_handoffs custody JOIN sessions session ON session.id=custody.customer_session_id
        AND session.tenant_id=custody.tenant_id AND session.user_id=custody.user_id
      WHERE custody.environment=$1 AND custody.security_epoch=$2 AND custody.platform_security_epoch=$3
        AND custody.customer_origin=$4 AND custody.platform_origin=$5 AND custody.status='consumed'
        AND session.id=$6 AND session.tenant_id=$7 AND session.user_id=$8 AND session.principal_version=$9
        AND session.provider='platform_owner' AND session.provider_identity_reference=$10 AND session.roles=$11::text[]
        AND session.permissions=$12::text[] AND session.issued_at=$13 AND session.expires_at=$14
        AND session.revoked_at IS NULL AND session.issued_at<=clock_timestamp() AND session.expires_at>clock_timestamp() LIMIT 1`,
    values: [...fixed,principal.session.id,principal.tenantId,principal.userId,principal.session.securityVersion,
      principal.providerIdentity.reference,principal.roles,principal.permissions,principal.session.issuedAt,principal.session.expiresAt] });
    if (result.rowCount!==1) return null;const row=await current(client,result.rows[0].id);if (!row) return null;
    const authorization=tenantAuthorizationSnapshot(row.selected_role==='employee' ? ['employee'] : ['employee',row.selected_role]);
    if (Number(row.user_security_version)!==principal.session.securityVersion
      || ownerCustomerAccessIdentityReference({ flowId: row.id,operatorId: row.operator_id,role: row.selected_role })
        !==principal.providerIdentity.reference || !sameSet(principal.roles,authorization.roles)
      || !sameSet(principal.permissions,authorization.permissions)) return null;
    return Object.freeze({ kind: 'owner_delegation',runtime: requireProtectedTenantRuntime({ ...protection,tenantId: principal.tenantId },{
      ...protection,tenantId: principal.tenantId,mode: 'real',generationId: null,generationState: null,operatorId: null,slot: null }) });
  }
  return Object.freeze({
    async isReady() {
      try {
        const result=await pool.query(`SELECT bool_and(has_function_privilege(current_user,signature,'EXECUTE')) AS allowed
          FROM unnest(ARRAY['public.protected_lock_owner_handoff_source(text,uuid,uuid)',
            'public.protected_lock_owner_customer_source(text,uuid,uuid)']) AS required(signature)`);
        return result.rowCount===1 && result.rows[0]?.allowed===true;
      } catch { return false; }
    },
    resolveCurrentAccess(input) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      return withPostgresTransaction(pool,client=>resolve(client,input),{ readOnly: true });
    },
    async lockCurrentAccessWithClient(client,input) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('OWNER_CUSTOMER_ACCESS_TRANSACTION_REQUIRED');
      if (!await resolve(client,input)) return false;
      const locked=await client.query({ name: 'owner-customer-final-write-source-lock',
        text: 'SELECT public.protected_lock_owner_customer_source($1,$2,$3) AS locked',
        values: [scope.environment,scope.securityEpoch,input.principal.session.id] });
      return locked.rowCount===1 && locked.rows[0]?.locked===true && await resolve(client,input)!==null;
    },
    currentWithClient(client,flowId) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('OWNER_CUSTOMER_ACCESS_TRANSACTION_REQUIRED');
      return current(client,flowId);
    },
  });
}
