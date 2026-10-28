import { isInternalUuid } from '../../domain/identifiers.js';
import { isPostgresTransactionActive } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

// Member-qualified DEV/INT port, distinct from the unchanged REAL predicate and
// the Platform's initial target/registration port. All IDs are server-derived.
export function createPostgresProtectedSyntheticParticipantScope(pool,{ environment,securityEpoch }={}) {
  if (!pool || typeof pool.connect!=='function' || !['dev','int'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_SYNTHETIC_PARTICIPANT_CONFIGURATION_INVALID');
  }
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  async function qualified(client,tenantId,member,admission) {
    requireProtectedRuntimeSharedExecutionScope(pool,scope);
    if (!isPostgresTransactionActive(pool,client) || !isInternalUuid(tenantId)) {
      throw new TypeError('PROTECTED_SYNTHETIC_PARTICIPANT_TRANSACTION_INVALID');
    }
    if (!member || ![Object.prototype,null].includes(Object.getPrototypeOf(member))) return false;
    const keys=Reflect.ownKeys(member);
    if (keys.length!==1 || !['membershipId','invitationId'].includes(keys[0])) return false;
    const field=Object.getOwnPropertyDescriptor(member,keys[0]);
    if (!field?.enumerable || !Object.hasOwn(field,'value') || !isInternalUuid(field.value)) return false;
    const result=await client.query({ name: 'protected-synthetic-participant-scope',text:
      'SELECT protected_lock_synthetic_participant_scope($1,$2,$3,$4,$5,$6) AS allowed',
    values: [environment,scope.securityEpoch,tenantId,keys[0]==='membershipId' ? field.value : null,
      keys[0]==='invitationId' ? field.value : null,admission] });
    return result.rowCount===1 && result.rows[0].allowed===true;
  }
  return Object.freeze({
    allowsWithClient: (client,tenantId,member)=>qualified(client,tenantId,member,false),
    lockAdmissionWithClient: (client,tenantId,member)=>qualified(client,tenantId,member,true),
  });
}
