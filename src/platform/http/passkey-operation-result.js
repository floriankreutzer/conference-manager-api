import { isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { readPlatformSessionToken,serializePlatformSessionCookie } from '../identity/session-cookie.js';
import { clearPlatformPasskeyTransactionCookie } from '../identity/passkey-auth-cookie.js';
import { PlatformHttpError } from './errors.js';

function invalid() { throw new PlatformHttpError(500,'PLATFORM_OPERATION_RESULT_INVALID'); }
function normalCookie(value) {
  if (typeof value!=='string' || value.length>256) invalid();
  const token=readPlatformSessionToken({ cookie: value.split(';')[0] }),age=value.match(/; Max-Age=([1-9]\d{0,4})$/);
  if (!token || !age || Number(age[1])>86400
    || value!==serializePlatformSessionCookie(token,{ secure: true,maxAgeSeconds: Number(age[1]) })) invalid();return value;
}

// Checks only committed result projection. It grants no operation context, MFA,
// issuer, database mutation or authority from browser-selected metadata.
export function requireCommittedPlatformPasskeyOperation(value,{ principal,securityEpoch }={}) {
  principal=normalizePlatformPrincipal(principal);
  if (value?.status!=='operation_completed' || !Array.isArray(value.setCookies) || value.setCookies.length!==2
    || value.setCookies[1]!==clearPlatformPasskeyTransactionCookie() || !isOpaqueBrowserToken(value.csrfToken)) invalid();
  const future=normalizePlatformPrincipal(value.principal);
  if (future.operatorId!==principal.operatorId || future.securityVersion!==principal.securityVersion
    || future.session.id===principal.session.id || future.session.securityEpoch!==securityEpoch
    || future.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER || future.assurance.level!=='mfa'
    || future.assurance.authenticationContext!=='cm:pk:v1' || future.targetScope.mode!==principal.targetScope.mode
    || ['provider','tenantReference','subjectReference'].some(key=>future.providerIdentity[key]!==principal.providerIdentity[key])
    || future.roles.join(',')!==principal.roles.join(',')) invalid();
  return Object.freeze({ principal: future,normalCookie: normalCookie(value.setCookies[0]),
    csrfToken: value.csrfToken,result: value.result });
}
