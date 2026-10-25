import { normalizeOwnerCustomerAccessScope } from './domain/owner-customer-handoff.js';
import { normalizePrincipal } from './identity/principal.js';
import { AuthorizationDeniedError } from './authorization/errors.js';
import { createPostgresOwnerCustomerAccessRepository } from './persistence/postgres/owner-customer-access-repository.js';
import { createPostgresTransactionAuthorityScope,withPostgresTransaction } from './persistence/postgres/transaction.js';

const NETWORK_METHODS=['discoverRooms','lookupFreeBusy','createCalendarEvent','updateCalendarEvent',
  'cancelCalendarEvent','verifyBasePermissions'];

// This private owning composition receives only a successfully qualified normal
// Customer Principal from its owned session resolver. Browser input, provider
// labels and Tenant selection can never admit transaction authority themselves.
export function createProtectedOwnerCustomerWriteCustody({ pool,scope: rawScope }={}) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope);
  const repository=createPostgresOwnerCustomerAccessRepository(pool,{ scope });
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  const authority=createPostgresTransactionAuthorityScope(pool,{
    denied: ()=>new AuthorizationDeniedError(),
    beforeWrite: (client,principal)=>repository.lockCurrentAccessWithClient(client,{ ...protection,principal }),
  });
  return Object.freeze({
    run: authority.run,isReady: repository.isReady,
    observe(principal) {
      if (principal?.providerIdentity?.provider!=='platform_owner') return principal;
      const current=normalizePrincipal(principal);authority.admit(current,JSON.stringify(current));return current;
    },
    // Wrap only the actual provider client's fixed network methods. Their
    // implementations perform no repository work, so even a max-one business
    // pool can retain source/Tenant/User/session locks until the attempt ends.
    // Each retry re-enters this guard; no blanket request transaction is added.
    providerClient(client) {
      const keys=['redirectUri','adminConsentUrl',...NETWORK_METHODS];
      if (!client || Reflect.ownKeys(client).length!==keys.length || Reflect.ownKeys(client).some(key=>!keys.includes(key))
        || typeof client.redirectUri!=='string' || typeof client.adminConsentUrl!=='function'
        || NETWORK_METHODS.some(name=>typeof client[name]!=='function')) {
        throw new TypeError('OWNER_CUSTOMER_PROVIDER_CLIENT_INVALID');
      }
      return Object.freeze({ redirectUri: client.redirectUri,adminConsentUrl: client.adminConsentUrl.bind(client),
        ...Object.fromEntries(NETWORK_METHODS.map(name=>[name,input=>authority.hasAuthority()
          ? withPostgresTransaction(pool,()=>client[name](input)) : client[name](input)])),
      });
    },
  });
}
