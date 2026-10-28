import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { TENANT_ROLE,tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { requireProtectedTenantRuntime } from '../../tenancy/protected-tenant-runtime.js';
import { isPostgresTransactionActive,withPostgresTransaction } from './transaction.js';
import { createPostgresProtectedInvitedTenantScope } from './protected-invited-tenant-scope.js';

function sameSet(left,right) {
  return left.length===right.length && left.every(value=>right.includes(value));
}

// This is current custody verification after namespace-bound token resolution,
// not an independent authentication grant. Synthetic delegation stays denied
// until its separate browser/proof-bound handoff repository is composed.
function createAccessRepository(pool,{ environment,securityEpoch },participantScope=null) {
  if (!pool || typeof pool.query!=='function' || !['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_CUSTOMER_ACCESS_REPOSITORY_CONFIGURATION_INVALID');
  }
  async function resolve(input,query) {
      if (!input || typeof input!=='object' || Array.isArray(input)
        || Object.keys(input).sort().join(',')!=='environment,principal,securityEpoch'
        || input.environment!==environment || input.securityEpoch!==securityEpoch) return null;
      let principal;try { principal=normalizePrincipal(input.principal); } catch { return null; }
      if (!['email_code','microsoft_entra'].includes(principal.providerIdentity.provider)) return null;
      if (participantScope && !await participantScope.allowsPrincipalWithClient(query,principal)) return null;
      const result=await query.query({ name: 'protected-customer-current-invited-access',text: `SELECT
          registry.mode,registry.generation_id,registry.operator_id,registry.slot,
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
        WHERE registry.environment=$1 AND registry.tenant_id=$3 AND (registry.mode='real' OR ($13::boolean AND registry.mode='synthetic'))
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
        principal.roles,principal.permissions,Boolean(participantScope)] });
      if (result.rowCount!==1) return null;
      const authorization=tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE,...result.rows[0].roles]);
      if (!sameSet(principal.roles,authorization.roles) || !sameSet(principal.permissions,authorization.permissions)) return null;
      const row=result.rows[0];
      if (participantScope && !['real','synthetic'].includes(row.mode)) return null;
      const synthetic=participantScope!==null && row.mode==='synthetic';
      const runtime=requireProtectedTenantRuntime({ environment,securityEpoch,tenantId: principal.tenantId },{
        environment,securityEpoch,tenantId: principal.tenantId,mode: synthetic ? 'synthetic' : 'real',
        generationId: synthetic ? row.generation_id : null,generationState: synthetic ? 'active' : null,
        operatorId: synthetic ? row.operator_id : null,slot: synthetic ? row.slot : null });
      return Object.freeze({ kind: synthetic ? 'synthetic_participant' : 'invited_membership',runtime });
  }
  return Object.freeze({
    resolveCurrentAccess: input=>participantScope || isPostgresTransactionActive(pool)
      ? withPostgresTransaction(pool,client=>resolve(input,client),{ readOnly: !participantScope }) : resolve(input,pool),
    resolveCurrentAccessWithClient(client,input) {
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('PROTECTED_CUSTOMER_ACCESS_TRANSACTION_REQUIRED');
      return resolve(input,client);
    },
  });
}

// Ordinary REAL custody cannot opt into participants through an ignored option.
export function createPostgresProtectedCustomerAccessRepository(pool,{ environment,securityEpoch }={}) {
  return createAccessRepository(pool,{ environment,securityEpoch });
}

// Separate DEV/INT construction requires exact live member/generation locks before
// re-reading identity, current roles and the persisted session on that client.
export function createPostgresProtectedParticipantCustomerAccessRepository(pool,{ environment,securityEpoch }={}) {
  if (!['dev','int'].includes(environment)) throw new TypeError('PROTECTED_SYNTHETIC_PARTICIPANT_CONFIGURATION_INVALID');
  const scope=createPostgresProtectedInvitedTenantScope(pool,{ environment,securityEpoch,syntheticParticipantsEnabled: true });
  return createAccessRepository(pool,{ environment,securityEpoch },scope);
}
