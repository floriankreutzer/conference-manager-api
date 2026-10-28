import { normalizeSyntheticHandoffScope } from '../../domain/synthetic-handoff.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { createPostgresSyntheticCustomerAccessRepository } from './synthetic-customer-access-repository.js';
import { createPostgresProtectedParticipantCustomerAccessRepository } from './protected-customer-access-repository.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';
import { isPostgresTransactionActive } from './transaction.js';

// Current source selection for synthetic business custody. A provider label only
// selects which authoritative reader must succeed; it never supplies authority.
export function createPostgresProtectedSyntheticCustomerCustody(pool,{ scope,syntheticParticipantsEnabled=false }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  if (typeof syntheticParticipantsEnabled!=='boolean') throw new TypeError('PROTECTED_SYNTHETIC_CUSTODY_CONFIGURATION_INVALID');
  const protection=Object.freeze({ environment: scope.environment,securityEpoch: scope.securityEpoch });
  const delegated=createPostgresSyntheticCustomerAccessRepository(pool,{ scope });
  const participant=syntheticParticipantsEnabled ? createPostgresProtectedParticipantCustomerAccessRepository(pool,protection) : null;
  async function resolve(input) {
    let principal;try { principal=normalizePrincipal(input?.principal); } catch { return null; }
    const source=principal.providerIdentity.provider==='platform_delegation' ? delegated : participant;
    if (!source) return null;
    const current=await source.resolveCurrentAccess(input);
    if (current?.runtime?.mode!=='synthetic') return null;
    return current;
  }
  return Object.freeze({
    resolveCurrentAccess: resolve,
    async lockCurrentAccessWithClient(client,input) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (!isPostgresTransactionActive(pool,client)) throw new TypeError('PROTECTED_SYNTHETIC_CUSTODY_TRANSACTION_REQUIRED');
      const first=await resolve(input);if (!first) return null;
      const principal=normalizePrincipal(input.principal);
      if (first.kind==='operator_delegation') {
        const locked=await client.query({ name: 'protected-calendar-source-lock',
          text: 'SELECT protected_lock_synthetic_calendar_source($1,$2,$3) AS allowed',
          values: [scope.environment,scope.securityEpoch,principal.session.id] });
        if (locked.rows[0]?.allowed!==true) return null;
      } else if (first.kind==='synthetic_participant') {
        // The participant reader already retains owner/generation/Tenant locks.
        // Also fence User disablement, session revocation and security-version
        // changes until this business transaction has committed or rolled back.
        try {
          const locked=await client.query({ name: 'protected-participant-current-session-lock',text: `SELECT person.id
            FROM users person JOIN sessions session ON session.tenant_id=person.tenant_id AND session.user_id=person.id
            WHERE person.tenant_id=$1 AND person.id=$2 AND person.active=true AND person.security_version=$3
              AND session.id=$4 AND session.principal_version=person.security_version AND session.revoked_at IS NULL
              AND session.expires_at>clock_timestamp() FOR SHARE OF person,session NOWAIT`,
          values: [principal.tenantId,principal.userId,principal.session.securityVersion,principal.session.id] });
          if (locked.rowCount!==1) return null;
        } catch (error) { if (error?.code==='55P03') return null;throw error; }
      } else return null;
      const current=await resolve(input);
      return current?.kind===first.kind && current.runtime.generationId===first.runtime.generationId
        && current.runtime.operatorId===first.runtime.operatorId && current.runtime.slot===first.runtime.slot ? current : null;
    },
  });
}
