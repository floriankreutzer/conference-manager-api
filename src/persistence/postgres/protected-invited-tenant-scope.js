import { createPostgresProtectedRealTenantScope } from './protected-real-tenant-scope.js';
import { createPostgresProtectedSyntheticParticipantScope } from './protected-synthetic-participant-scope.js';

// Only this owned admission composition can add member-qualified participants.
// The existing REAL predicate itself remains fixed and unchanged. A Tenant-only
// call can never qualify synthetic membership, even when the option is enabled.
export function createPostgresProtectedInvitedTenantScope(pool,
  { environment,securityEpoch,syntheticParticipantsEnabled=false }={}) {
  if (typeof syntheticParticipantsEnabled!=='boolean'
    || syntheticParticipantsEnabled && !['dev','int'].includes(environment)) {
    throw new TypeError('PROTECTED_SYNTHETIC_PARTICIPANT_CONFIGURATION_INVALID');
  }
  const real=createPostgresProtectedRealTenantScope(pool,{ environment,securityEpoch });
  if (!syntheticParticipantsEnabled) return real;
  const participant=createPostgresProtectedSyntheticParticipantScope(pool,{ environment,securityEpoch });
  async function qualified(method,client,tenantId,member) {
    if (await real[method](client,tenantId)) return true;
    return participant[method](client,tenantId,member);
  }
  return Object.freeze({
    allowsWithClient: (client,tenantId,member)=>qualified('allowsWithClient',client,tenantId,member),
    lockAdmissionWithClient: (client,tenantId,member)=>qualified('lockAdmissionWithClient',client,tenantId,member),
  });
}
