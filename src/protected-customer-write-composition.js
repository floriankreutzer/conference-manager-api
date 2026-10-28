import { AsyncLocalStorage } from 'node:async_hooks';
import { isInternalUuid } from './domain/identifiers.js';
import { normalizeOwnerCustomerAccessScope } from './domain/owner-customer-handoff.js';
import { normalizeSyntheticHandoffScope } from './domain/synthetic-handoff.js';
import { normalizePrincipal } from './identity/principal.js';
import { AuthorizationDeniedError } from './authorization/errors.js';
import { createPostgresOwnerCustomerAccessRepository } from './persistence/postgres/owner-customer-access-repository.js';
import { createPostgresProtectedParticipantCustomerAccessRepository } from './persistence/postgres/protected-customer-access-repository.js';
import { createPostgresProtectedSyntheticCustomerCustody } from './persistence/postgres/protected-synthetic-customer-custody.js';
import { createPostgresTransactionAuthorityScope,withPostgresTransaction } from './persistence/postgres/transaction.js';

const NETWORK_METHODS=['discoverRooms','lookupFreeBusy','createCalendarEvent','updateCalendarEvent',
  'cancelCalendarEvent','verifyBasePermissions'];
function denied() { throw new AuthorizationDeniedError(); }

// One pool owns one transaction precondition. Both sources enter only after the
// owned normal session resolver has qualified a principal. No browser kind is read.
export function createProtectedCustomerWriteCustody({ pool,environment,securityEpoch,ownerScope=null,syntheticScope=null,
  syntheticParticipantsEnabled=false }={}) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)
    || typeof syntheticParticipantsEnabled!=='boolean' || ownerScope===null && !syntheticParticipantsEnabled
    || syntheticParticipantsEnabled && (syntheticScope===null || environment==='prod')) {
    throw new TypeError('PROTECTED_CUSTOMER_WRITE_CONFIGURATION_INVALID');
  }
  const protection=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  if (ownerScope!==null) ownerScope=normalizeOwnerCustomerAccessScope(ownerScope);
  if (syntheticScope!==null) syntheticScope=normalizeSyntheticHandoffScope(syntheticScope);
  if ([ownerScope,syntheticScope].some(scope=>scope!==null
    && (scope.environment!==environment || scope.securityEpoch!==protection.securityEpoch))) {
    throw new TypeError('PROTECTED_CUSTOMER_WRITE_CONFIGURATION_INVALID');
  }
  const owner=ownerScope===null ? null : createPostgresOwnerCustomerAccessRepository(pool,{ scope: ownerScope });
  const participants=syntheticParticipantsEnabled ? createPostgresProtectedParticipantCustomerAccessRepository(pool,protection) : null;
  const synthetic=syntheticParticipantsEnabled ? createPostgresProtectedSyntheticCustomerCustody(pool,
    { scope: syntheticScope,syntheticParticipantsEnabled: true }) : null;
  const observed=new AsyncLocalStorage();
  const authority=createPostgresTransactionAuthorityScope(pool,{
    denied: ()=>new AuthorizationDeniedError(),
    async beforeWrite(client,value) {
      const input={ ...protection,principal: value.principal };
      if (value.kind==='owner_delegation') return owner!==null && owner.lockCurrentAccessWithClient(client,input);
      if (value.kind!=='synthetic_participant' || synthetic===null) return false;
      const current=await synthetic.lockCurrentAccessWithClient(client,input);
      return current?.kind==='synthetic_participant';
    },
  });
  function admit(principal,kind) {
    const active=observed.getStore();if (!active?.live) denied();
    const value=Object.freeze({ principal,kind });authority.admit(value,JSON.stringify(value));active.kind=kind;return principal;
  }
  async function observeParticipant(value) {
    if (!observed.getStore()?.live) denied();
    const principal=normalizePrincipal(value),current=await participants.resolveCurrentAccess({ ...protection,principal });
    if (!current) denied();
    if (current.kind==='synthetic_participant') return admit(principal,current.kind);
    if (current.kind!=='invited_membership' || current.runtime.mode!=='real') denied();
    if (!observed.getStore()?.live) denied();return principal;
  }
  return Object.freeze({
    async run(work) {
      if (typeof work!=='function') throw new TypeError('TRANSACTION_AUTHORITY_WORK_REQUIRED');
      return authority.run(()=>{
        const enclosing=observed.getStore();
        if (enclosing) { if (!enclosing.live) denied();return work(); }
        const active={ live: true,kind: null };
        return observed.run(active,async()=>{ try { return await work(); } finally { active.live=false; } });
      });
    },
    async isReady() {
      if (owner!==null && !await owner.isReady()) return false;
      return synthetic===null || await synthetic.isReady();
    },
    observe(principal) {
      const provider=principal?.providerIdentity?.provider;
      if (provider==='platform_owner') {
        if (owner===null) denied();return admit(normalizePrincipal(principal),'owner_delegation');
      }
      if (participants!==null && ['email_code','microsoft_entra'].includes(provider)) return observeParticipant(principal);
      return principal;
    },
    providerClient(client) {
      const keys=['redirectUri','adminConsentUrl',...NETWORK_METHODS];
      if (!client || Reflect.ownKeys(client).length!==keys.length || Reflect.ownKeys(client).some(key=>!keys.includes(key))
        || typeof client.redirectUri!=='string' || typeof client.adminConsentUrl!=='function'
        || NETWORK_METHODS.some(name=>typeof client[name]!=='function')) {
        throw new TypeError('OWNER_CUSTOMER_PROVIDER_CLIENT_INVALID');
      }
      function realOnly() {
        if (observed.getStore()?.kind==='synthetic_participant') denied();
      }
      return Object.freeze({ redirectUri: client.redirectUri,
        adminConsentUrl(...args) { realOnly();return client.adminConsentUrl(...args); },
        ...Object.fromEntries(NETWORK_METHODS.map(name=>[name,input=>{
          realOnly();return authority.hasAuthority() ? withPostgresTransaction(pool,()=>client[name](input)) : client[name](input);
        }])),
      });
    },
  });
}
