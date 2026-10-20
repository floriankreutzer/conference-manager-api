import { normalizeSyntheticHandoffScope,syntheticHandoffOperationHash,syntheticDelegationIdentityReference }
  from '../../domain/synthetic-handoff.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { requireProtectedTenantRuntime } from '../../tenancy/protected-tenant-runtime.js';
import { withPostgresTransaction,isPostgresTransactionActive } from './transaction.js';

function sameSet(left,right) {
  return Array.isArray(left) && Array.isArray(right) && left.length===right.length && left.every(value=>right.includes(value));
}
function selection(row) {
  return { flowId: row.id,operatorId: row.operator_id,generationId: row.generation_id,slot: row.slot,role: row.selected_role };
}
function binding(row) { return { flowId: row.id,stateHash: row.state_hash,browserVerifier: row.browser_verifier }; }

// Private custody reader, not a new authentication method. The caller first
// resolves the existing namespace-bound Customer cookie or proves the original
// browser and fresh approval code. Expired approval codes/proofs do not expire
// an already consumed Customer session; current source MFA custody still does.
export function createPostgresSyntheticCustomerAccessRepository(pool,{ scope }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  if (typeof pool?.query!=='function' || typeof pool?.connect!=='function') {
    throw new TypeError('SYNTHETIC_CUSTOMER_ACCESS_CONFIGURATION_INVALID');
  }
  const fixed=[scope.environment,scope.securityEpoch,scope.platformSecurityEpoch,scope.customerOrigin,scope.platformOrigin];
  async function current(client,flowId) {
    if (!isInternalUuid(flowId)) return null;
    const result=await client.query({ name: 'synthetic-customer-current-custody',text: `SELECT custody.*,
        ARRAY(SELECT role FROM tenant_user_roles WHERE tenant_id=person.tenant_id AND user_id=person.id ORDER BY role) AS current_roles
      FROM synthetic_customer_handoffs custody JOIN protected_runtime_deployments deployment
        ON deployment.environment=custody.environment AND deployment.security_epoch=custody.security_epoch
      JOIN synthetic_tenant_generations generation ON generation.environment=custody.environment
        AND generation.id=custody.generation_id AND generation.operator_id=custody.operator_id
      JOIN tenant_runtime_registry registry ON registry.environment=custody.environment AND registry.tenant_id=custody.tenant_id
      JOIN platform_operators actor ON actor.id=custody.operator_id
      JOIN platform_sessions source ON source.id=custody.source_platform_session_id AND source.operator_id=actor.id
      JOIN tenants tenant ON tenant.id=custody.tenant_id
      JOIN users person ON person.tenant_id=tenant.id AND person.id=custody.user_id
      JOIN user_identity_bindings identity ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id
        AND identity.provider='platform_delegation' AND identity.provider_tenant_reference=generation.id::text
        AND identity.provider_user_reference=actor.id::text||':'||custody.selected_role
      JOIN platform_passkey_auth_transactions proof ON proof.id=custody.approval_proof_id AND proof.operator_id=actor.id
      JOIN platform_audit_events evidence ON evidence.sequence=custody.approval_audit_sequence AND evidence.operator_id=actor.id
      WHERE custody.environment=$1 AND custody.security_epoch=$2 AND custody.platform_security_epoch=$3
        AND custody.customer_origin=$4 AND custody.platform_origin=$5 AND custody.id=$6 AND custody.status IN ('approved','consumed')
        AND registry.mode='synthetic' AND registry.generation_id=generation.id AND registry.operator_id=actor.id
        AND registry.slot=custody.slot
        AND generation.security_epoch=custody.security_epoch AND generation.state='active'
        AND generation.operator_security_version=custody.operator_security_version
        AND actor.status='active' AND actor.provider='microsoft_entra_platform' AND actor.security_version=custody.operator_security_version
        AND tenant.status IN ('onboarding','ready','active') AND person.active=true
        AND person.security_version=custody.user_security_version
        AND source.provider=actor.provider AND source.provider_tenant_reference=actor.provider_tenant_reference
        AND source.provider_subject_reference=actor.provider_subject_reference AND source.roles=actor.roles
        AND source.scope_mode=actor.scope_mode
        AND source.principal_version=actor.security_version AND source.security_epoch=custody.platform_security_epoch
        AND source.assurance_level='mfa' AND source.authentication_context='cm:pk:v1' AND source.revoked_at IS NULL
        AND source.issued_at<=clock_timestamp()+interval '1 minute' AND source.expires_at>clock_timestamp()
        AND 'platform:lifecycle:manage'=ANY(source.permissions)
        AND (SELECT count(*) FROM platform_passkey_credentials key
          WHERE key.operator_id=actor.id AND key.environment=custody.environment AND key.revoked_at IS NULL)>=2
        AND proof.environment=custody.environment AND proof.security_epoch=custody.platform_security_epoch
        AND proof.operator_security_version=custody.operator_security_version AND proof.purpose='step_up'
        AND proof.operation_hash=custody.operation_hash AND proof.expected_session_id<>source.id
        AND proof.consumed_at IS NOT NULL AND proof.consumed_at<proof.expires_at
        AND date_trunc('milliseconds',proof.consumed_at)=source.authenticated_at
        AND custody.approved_at>=date_trunc('milliseconds',proof.consumed_at)
        AND custody.approved_at<=date_trunc('milliseconds',proof.consumed_at)+interval '30 seconds'
        AND evidence.action='platform.synthetic_access.approved' AND evidence.target_tenant_id=tenant.id
        AND evidence.outcome='success' AND evidence.assurance_level='step_up'
        AND evidence.metadata=jsonb_build_object('mode','synthetic','generationId',generation.id::text,
          'slot',registry.slot,'role',custody.selected_role) LIMIT 1`,values: [...fixed,flowId] });
    if (result.rowCount!==1) return null;
    const row=result.rows[0];
    try {
      const elevated=row.selected_role==='employee' ? [] : [row.selected_role];
      if (!sameSet(row.current_roles,elevated)
        || syntheticHandoffOperationHash(scope,selection(row),binding(row))!==row.operation_hash
        || !Number.isSafeInteger(Number(row.user_security_version)) || Number(row.user_security_version)<1) return null;
    } catch { return null; }
    return row;
  }
  async function resolve(client,input) {
    if (!input || Object.keys(input).sort().join(',')!=='environment,principal,securityEpoch'
      || input.environment!==scope.environment || input.securityEpoch!==scope.securityEpoch) return null;
    let principal;try { principal=normalizePrincipal(input.principal); } catch { return null; }
    if (principal.providerIdentity.provider!=='platform_delegation') return null;
    const result=await client.query({ name: 'synthetic-customer-session-custody',text: `SELECT custody.id
      FROM synthetic_customer_handoffs custody JOIN sessions session ON session.id=custody.customer_session_id
        AND session.tenant_id=custody.tenant_id AND session.user_id=custody.user_id
      WHERE custody.environment=$1 AND custody.security_epoch=$2 AND custody.platform_security_epoch=$3
        AND custody.customer_origin=$4 AND custody.platform_origin=$5 AND custody.status='consumed'
        AND session.id=$6 AND session.tenant_id=$7 AND session.user_id=$8 AND session.principal_version=$9
        AND session.provider='platform_delegation' AND session.provider_identity_reference=$10 AND session.roles=$11::text[]
        AND session.permissions=$12::text[] AND session.issued_at=$13 AND session.expires_at=$14
        AND session.revoked_at IS NULL AND session.issued_at<=clock_timestamp() AND session.expires_at>clock_timestamp() LIMIT 1`,
    values: [...fixed,principal.session.id,principal.tenantId,principal.userId,principal.session.securityVersion,
      principal.providerIdentity.reference,principal.roles,principal.permissions,principal.session.issuedAt,principal.session.expiresAt] });
    if (result.rowCount!==1) return null;
    const row=await current(client,result.rows[0].id);if (!row) return null;
    const authorization=tenantAuthorizationSnapshot(row.selected_role==='employee' ? ['employee'] : ['employee',row.selected_role]);
    if (Number(row.user_security_version)!==principal.session.securityVersion
      || syntheticDelegationIdentityReference({ generationId: row.generation_id,operatorId: row.operator_id,role: row.selected_role })
        !==principal.providerIdentity.reference || !sameSet(principal.roles,authorization.roles)
      || !sameSet(principal.permissions,authorization.permissions)) return null;
    return Object.freeze({ kind: 'operator_delegation',runtime: requireProtectedTenantRuntime({
      environment: scope.environment,securityEpoch: scope.securityEpoch,tenantId: principal.tenantId },{
      environment: scope.environment,securityEpoch: scope.securityEpoch,tenantId: principal.tenantId,mode: 'synthetic',
      generationId: row.generation_id,generationState: 'active',operatorId: row.operator_id,slot: row.slot }) });
  }
  return Object.freeze({
    resolveCurrentAccess: input=>withPostgresTransaction(pool,client=>resolve(client,input),{ readOnly: true }),
    currentWithClient(client,flowId) {
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('SYNTHETIC_CUSTOMER_TRANSACTION_REQUIRED');
      return current(client,flowId);
    },
  });
}
