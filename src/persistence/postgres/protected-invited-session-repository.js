import { isInternalUuid } from '../../domain/identifiers.js';
import { SessionServiceError } from '../../identity/session-service.js';
import { createPostgresSessionRepository } from './session-repository.js';
import { createPostgresProtectedCustomerAccessRepository,createPostgresProtectedParticipantCustomerAccessRepository }
  from './protected-customer-access-repository.js';
import { withPostgresTransaction } from './transaction.js';

function principalFor(stored) {
  return { tenantId: stored.tenantId,userId: stored.userId,providerIdentity: stored.providerIdentity,
    roles: stored.roles,permissions: stored.permissions,session: { id: stored.id,securityVersion: stored.securityVersion,
      issuedAt: stored.issuedAt,expiresAt: stored.expiresAt } };
}

// Session/audit and current invited real custody share the admission/link
// transaction and pool. A failed qualification rolls back issuance completely,
// so an unclassified cookie cannot become valid after later classification.
function createInvitedSessionRepository(pool,{ environment,securityEpoch,auditRepository },participants=false) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_INVITED_SESSION_REPOSITORY_CONFIGURATION_INVALID');
  }
  const ordinary=createPostgresSessionRepository(pool,{ auditRepository });
  const factory=participants ? createPostgresProtectedParticipantCustomerAccessRepository : createPostgresProtectedCustomerAccessRepository;
  const access=factory(pool,{ environment,securityEpoch });
  async function qualified(client,stored) {
    if (!stored) return null;
    const current=await access.resolveCurrentAccessWithClient(client,{ environment,securityEpoch,principal: principalFor(stored) });
    if (!current || current.kind!=='invited_membership' && !(participants && current.kind==='synthetic_participant')) {
      throw new SessionServiceError('IDENTITY_NOT_PROVISIONED');
    }
    return stored;
  }
  return Object.freeze({ ...ordinary,
    matchesProtectionScope: scope=>scope?.environment===environment && scope?.securityEpoch===securityEpoch,
    matchesParticipantProtectionScope: scope=>participants && scope?.environment===environment && scope?.securityEpoch===securityEpoch,
    issue: (record,event)=>withPostgresTransaction(pool,async client=>qualified(client,await ordinary.issue(record,event))),
    rotate: input=>withPostgresTransaction(pool,async client=>qualified(client,await ordinary.rotate(input))),
  });
}

export function createPostgresProtectedInvitedSessionRepository(pool,{ environment,securityEpoch,auditRepository }={}) {
  return createInvitedSessionRepository(pool,{ environment,securityEpoch,auditRepository });
}

export function createPostgresProtectedParticipantSessionRepository(pool,{ environment,securityEpoch,auditRepository }={}) {
  return createInvitedSessionRepository(pool,{ environment,securityEpoch,auditRepository },true);
}
