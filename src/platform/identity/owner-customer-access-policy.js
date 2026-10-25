import { normalizePlatformPrincipal } from './principal.js';
import { PLATFORM_ROLE } from './policy.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizeOwnerCustomerAccessScope,normalizeOwnerCustomerAccessSelection }
  from '../../domain/owner-customer-handoff.js';
import { PlatformAuthorizationError } from './errors.js';

const ROLES=Object.freeze(Object.values(PLATFORM_ROLE).sort());
const NORMAL='cm:ms:mfa:v1',FRESH='cm:ms:fresh:v1';
function denied() { throw new PlatformAuthorizationError('OWNER_CUSTOMER_ACCESS_DENIED'); }

// Necessary principal checks only. They never establish that this operator is
// the designated owner. The locked persistence boundary must independently
// verify bootstrap/all-role receipts, current operator/source/epochs, REAL
// registry, active target User and the consumed shared Microsoft proof.
export function createOwnerCustomerAccessPolicy(rawScope) {
  const scope=normalizeOwnerCustomerAccessScope(rawScope);
  function principal(value,operatorId,level) {
    const current=normalizePlatformPrincipal(value);
    if (current.operatorId!==operatorId || current.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER
      || current.targetScope.mode!=='all' || current.roles.length!==ROLES.length
      || current.roles.some((role,index)=>role!==ROLES[index])
      || current.session.securityEpoch!==scope.platformSecurityEpoch || current.assurance.level!==level
      || current.assurance.authenticationContext!==(level==='mfa' ? NORMAL : FRESH)) denied();
    return current;
  }
  return Object.freeze({
    owner(value) {
      const current=normalizePlatformPrincipal(value);return principal(current,current.operatorId,'mfa');
    },
    prepare(value,rawSelection) {
      return principal(value,normalizeOwnerCustomerAccessSelection(rawSelection).operatorId,'mfa');
    },
    continuation(value,future,rawSelection) {
      const selection=normalizeOwnerCustomerAccessSelection(rawSelection);
      const approved=principal(value,selection.operatorId,'step_up'),source=principal(future,selection.operatorId,'mfa');
      if (source.securityVersion!==approved.securityVersion || source.session.id===approved.session.id
        || source.assurance.authenticatedAt!==approved.assurance.authenticatedAt
        || ['provider','tenantReference','subjectReference']
          .some(key=>source.providerIdentity[key]!==approved.providerIdentity[key])) denied();
      return Object.freeze({ principal: approved,continuationPrincipal: source });
    },
  });
}
