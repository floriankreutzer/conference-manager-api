import { createPostgresProtectedRealTenantScope } from './protected-real-tenant-scope.js';
import { createPostgresProtectedSyntheticParticipantScope } from './protected-synthetic-participant-scope.js';
import { normalizePrincipal } from '../../identity/principal.js';

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
  async function principalScope(method,client,value) {
    let principal;try { principal=normalizePrincipal(value); } catch { return false; }
    if (!['email_code','microsoft_entra'].includes(principal.providerIdentity.provider)) return false;
    // The fixed REAL call validates the live lease/transaction before any read.
    if (await real[method](client,principal.tenantId)) return true;
    const result=await client.query({ name: 'protected-participant-principal-member',text: `SELECT id
      FROM customer_access_memberships WHERE environment=$1 AND tenant_id=$2 AND user_id=$3
        AND accepted_at IS NOT NULL LIMIT 2`,values: [environment,principal.tenantId,principal.userId] });
    if (result.rowCount!==1) return false;
    return participant[method](client,principal.tenantId,{ membershipId: result.rows[0].id });
  }
  return Object.freeze({
    allowsWithClient: (client,tenantId,member)=>qualified('allowsWithClient',client,tenantId,member),
    lockAdmissionWithClient: (client,tenantId,member)=>qualified('lockAdmissionWithClient',client,tenantId,member),
    allowsPrincipalWithClient: (client,principal)=>principalScope('allowsWithClient',client,principal),
    lockPrincipalAdmissionWithClient: (client,principal)=>principalScope('lockAdmissionWithClient',client,principal),
  });
}
