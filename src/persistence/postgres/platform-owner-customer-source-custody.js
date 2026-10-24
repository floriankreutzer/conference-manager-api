import { normalizeOwnerCustomerAccessScope,normalizeOwnerCustomerAccessSelection } from '../../domain/owner-customer-handoff.js';
import { createOwnerCustomerAccessPolicy } from '../../platform/identity/owner-customer-access-policy.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { isPostgresTransactionActive } from './transaction.js';

// Private preparation/final-approval port. A successful read proves only the
// current designated owner/source and REAL target. It cannot issue an identity,
// approve a handoff, consume a proof or establish Customer application access.
export function createPostgresOwnerCustomerSourceCustody(pool,{ scope: rawScope }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope),policy=createOwnerCustomerAccessPolicy(scope);
  if (typeof pool?.connect!=='function' || typeof pool?.query!=='function') {
    throw new TypeError('OWNER_CUSTOMER_SOURCE_CONFIGURATION_INVALID');
  }
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  return Object.freeze({
    async currentWithClient(client,{ principal: value,selection: rawSelection }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('OWNER_CUSTOMER_SOURCE_TRANSACTION_REQUIRED');
      const selection=normalizeOwnerCustomerAccessSelection(rawSelection),principal=policy.prepare(value,selection);
      const result=await client.query({ name: 'owner-customer-current-source-and-real-target',text: `SELECT
          actor.id AS operator_id,tenant.id AS tenant_id,source.id AS source_session_id,source.expires_at,
          bootstrap.sequence AS bootstrap_sequence,owner_roles.sequence AS owner_roles_sequence
        FROM platform_operators actor JOIN platform_sessions source ON source.operator_id=actor.id
        JOIN protected_runtime_deployments deployment ON deployment.environment=$1 AND deployment.security_epoch=$2
        JOIN tenant_runtime_registry registry ON registry.environment=deployment.environment AND registry.tenant_id=$3
          AND registry.mode='real'
        JOIN tenants tenant ON tenant.id=registry.tenant_id
        JOIN platform_audit_events bootstrap ON bootstrap.target_type='platform_operator_bootstrap'
          AND bootstrap.target_id=actor.id::text AND bootstrap.operator_id IS NULL
          AND bootstrap.action='platform.operator.changed' AND bootstrap.assurance_level='offline_owner'
          AND bootstrap.outcome='success' AND bootstrap.retention_class='recovery'
          AND bootstrap.metadata->>'operation'='first_owner_bootstrap' AND bootstrap.metadata->>'environment'=$1
        JOIN platform_audit_events owner_roles ON owner_roles.target_type='platform_owner_roles'
          AND owner_roles.target_id=actor.id::text AND owner_roles.operator_id IS NULL
          AND owner_roles.action='platform.operator.changed' AND owner_roles.assurance_level='offline_owner'
          AND owner_roles.outcome='success' AND owner_roles.retention_class='recovery'
          AND owner_roles.metadata->>'operation'='owner_all_platform_roles' AND owner_roles.metadata->>'environment'=$1
        WHERE actor.id=$4 AND actor.status='active' AND actor.provider='microsoft_entra_platform'
          AND actor.provider_tenant_reference=$5 AND actor.provider_subject_reference=$6 AND actor.security_version=$7
          AND actor.scope_mode='all' AND actor.roles=$8::text[]
          AND (SELECT count(*) FROM platform_audit_events WHERE target_type='platform_operator_bootstrap')=1
          AND (SELECT count(*) FROM platform_audit_events WHERE target_type='platform_owner_roles')=1
          AND tenant.status IN ('pending','onboarding','ready','active')
          AND source.id=$9 AND source.principal_version=actor.security_version AND source.security_epoch=$10
          AND source.provider=actor.provider AND source.provider_tenant_reference=actor.provider_tenant_reference
          AND source.provider_subject_reference=actor.provider_subject_reference AND source.roles=actor.roles
          AND source.scope_mode=actor.scope_mode AND source.permissions=$11::text[]
          AND source.assurance_level='mfa' AND source.authentication_context='cm:ms:mfa:v1'
          AND source.step_up_expires_at IS NULL AND source.authenticated_at=$12
          AND source.issued_at=$13 AND source.expires_at=$14 AND source.revoked_at IS NULL
          AND source.expires_at>clock_timestamp() AND source.issued_at<=clock_timestamp()+interval '1 minute'
        FOR SHARE OF actor,source,deployment,tenant`,
      values: [scope.environment,scope.securityEpoch,selection.tenantId,principal.operatorId,
        principal.providerIdentity.tenantReference,principal.providerIdentity.subjectReference,principal.securityVersion,
        principal.roles,principal.session.id,scope.platformSecurityEpoch,principal.permissions,principal.assurance.authenticatedAt,
        principal.session.issuedAt,principal.session.expiresAt] });
      if (result.rowCount!==1) return null;const row=result.rows[0];
      if (!(row.expires_at instanceof Date) || !Number.isFinite(row.expires_at.getTime())
        || [row.bootstrap_sequence,row.owner_roles_sequence].some(value=>!/^[1-9]\d{0,18}$/.test(String(value)))) {
        throw new Error('OWNER_CUSTOMER_SOURCE_RESULT_INVALID');
      }
      return Object.freeze({ operatorId: row.operator_id,tenantId: row.tenant_id,sourceSessionId: row.source_session_id,
        sourceExpiresAt: row.expires_at.toISOString(),bootstrapAuditSequence: String(row.bootstrap_sequence),
        ownerRolesAuditSequence: String(row.owner_roles_sequence) });
    },
  });
}
