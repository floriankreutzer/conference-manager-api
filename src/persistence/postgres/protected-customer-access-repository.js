import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { TENANT_ROLE,tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { requireProtectedTenantRuntime } from '../../tenancy/protected-tenant-runtime.js';
import { isPostgresTransactionActive,withPostgresTransaction } from './transaction.js';

function sameSet(left,right) {
  return left.length===right.length && left.every(value=>right.includes(value));
}

// This is current custody verification after namespace-bound token resolution,
// not an independent authentication grant. Synthetic delegation stays denied
// until its separate browser/proof-bound handoff repository is composed.
export function createPostgresProtectedCustomerAccessRepository(pool,{ environment,securityEpoch }={}) {
  if (!pool || typeof pool.query!=='function' || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_CUSTOMER_ACCESS_REPOSITORY_CONFIGURATION_INVALID');
  }
  async function resolve(input,query) {
      if (!input || typeof input!=='object' || Array.isArray(input)
        || Object.keys(input).sort().join(',')!=='environment,principal,securityEpoch'
        || input.environment!==environment || input.securityEpoch!==securityEpoch) return null;
      let principal;try { principal=normalizePrincipal(input.principal); } catch { return null; }
      if (!['email_code','microsoft_entra'].includes(principal.providerIdentity.provider)) return null;
      const result=await query.query({ name: 'protected-customer-current-invited-access',text: `SELECT
          ARRAY(SELECT role FROM (SELECT * FROM tenant_user_roles
      WHERE tenant_role_source_active(direct_grant,microsoft_verified_until)) AS effective_role_source
      WHERE tenant_id=person.tenant_id AND user_id=person.id ORDER BY role) AS roles
        FROM tenant_runtime_registry registry JOIN protected_runtime_deployments deployment
          ON deployment.environment=registry.environment AND deployment.security_epoch=$2
        JOIN tenants tenant ON tenant.id=registry.tenant_id
        JOIN customer_access_memberships member ON member.environment=registry.environment AND member.tenant_id=tenant.id
          AND member.user_id=$4 AND member.accepted_at IS NOT NULL
        JOIN users person ON person.tenant_id=tenant.id AND person.id=member.user_id
        JOIN sessions session ON session.tenant_id=tenant.id AND session.user_id=person.id AND session.id=$5
        JOIN user_identity_bindings identity ON identity.tenant_id=tenant.id AND identity.user_id=person.id
          AND identity.provider=session.provider
        WHERE registry.environment=$1 AND registry.tenant_id=$3 AND registry.mode='real'
          AND tenant.status IN ('pending','onboarding','ready','active') AND person.active=true AND person.security_version=$6
          AND session.principal_version=$6 AND session.provider=$7 AND session.provider_identity_reference=$8
          AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp() AND session.issued_at<=clock_timestamp()
          AND session.issued_at=$9 AND session.expires_at=$10 AND session.roles=$11::text[] AND session.permissions=$12::text[]
          AND ((session.provider='email_code' AND identity.provider_tenant_reference=$1
            AND identity.provider_user_reference=member.mailbox_id::text AND session.provider_identity_reference=member.mailbox_id::text)
            OR (session.provider='microsoft_entra' AND session.provider_identity_reference=
              identity.provider_tenant_reference||':'||identity.provider_user_reference)) LIMIT 1`,
      values: [environment,securityEpoch,principal.tenantId,principal.userId,principal.session.id,principal.session.securityVersion,
        principal.providerIdentity.provider,principal.providerIdentity.reference,principal.session.issuedAt,principal.session.expiresAt,
        principal.roles,principal.permissions] });
      if (result.rowCount!==1) return null;
      const authorization=tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE,...result.rows[0].roles]);
      if (!sameSet(principal.roles,authorization.roles) || !sameSet(principal.permissions,authorization.permissions)) return null;
      const runtime=requireProtectedTenantRuntime({ environment,securityEpoch,tenantId: principal.tenantId },{
        environment,securityEpoch,tenantId: principal.tenantId,mode: 'real',
        generationId: null,generationState: null,operatorId: null,slot: null });
      return Object.freeze({ kind: 'invited_membership',runtime });
  }
  return Object.freeze({
    resolveCurrentAccess: input=>isPostgresTransactionActive(pool)
      ? withPostgresTransaction(pool,client=>resolve(input,client),{ readOnly: true }) : resolve(input,pool),
    resolveCurrentAccessWithClient(client,input) {
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('PROTECTED_CUSTOMER_ACCESS_TRANSACTION_REQUIRED');
      return resolve(input,client);
    },
  });
}
