import { APPROVED_OUTBOUND_ORIGINS } from '../config.js';
import { EntraAuthenticationError } from './entra-errors.js';

const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const OPTIONAL_CLAIMS=['signin_state','login_hint','tenant_region_sub_scope'];
const SDK_METADATA=['clidata','client_info','client-request-id','x-client-SKU','x-client-VER','x-client-OS','x-client-CPU',
  'x-app-name','x-app-ver'];
function invalid() { throw new EntraAuthenticationError('ENTRA_FRESH_AUTHORIZATION_URL_INVALID'); }
// Presentation-output validation shares the approved provider boundary without
// moving destination configuration or SDK behavior into an HTTP handler.
export function checkedCustomerMicrosoftBrowserRedirect(value) {
  if (typeof value!=='string' || value.length>8192) invalid();
  let url;try { url=new URL(value); } catch { invalid(); }
  if (url.origin!==APPROVED_OUTBOUND_ORIGINS.microsoftIdentity
    || url.pathname!=='/organizations/oauth2/v2.0/authorize' || url.username || url.password || url.hash) invalid();return value;
}
export function customerMicrosoftEndpoints({ clientId,authority,publicOrigin }) {
  let issuer,origin;
  try { issuer=new URL(authority);origin=new URL(publicOrigin); } catch { throw new TypeError('ENTRA_FRESH_ENDPOINT_INVALID'); }
  if (issuer.origin!==APPROVED_OUTBOUND_ORIGINS.microsoftIdentity || issuer.pathname!=='/organizations'
    || issuer.username || issuer.password || issuer.search || issuer.hash || authority!==issuer.toString()
    || origin.protocol!=='https:' || origin.origin!==publicOrigin || origin.username || origin.password
    || origin.pathname!=='/' || origin.search || origin.hash) throw new TypeError('ENTRA_FRESH_ENDPOINT_INVALID');
  return Object.freeze({ clientId,authority: issuer.toString(),publicOrigin,
    redirectUri: new URL('/api/v1/auth/microsoft/callback',origin).toString() });
}
// Only optional SDK telemetry/offline scope and optional false SDK claims are
// normalized. Unknown authority or proof fields survive until strict rejection.
export function normalizeFreshCustomerMicrosoftUrl(value,endpoints,{ state,nonce,codeChallenge }) {
  if (![state,nonce,codeChallenge].every(item=>typeof item==='string' && TOKEN.test(item))
    || typeof value!=='string' || value.length>8192) invalid();
  const url=new URL(checkedCustomerMicrosoftBrowserRedirect(value));
  const authority=new URL(endpoints.authority);
  if (url.origin!==authority.origin || url.pathname!==`${authority.pathname}/oauth2/v2.0/authorize`
    || url.username || url.password || url.hash) invalid();
  const parameters=url.searchParams;
  if ([...parameters.keys()].some(key=>parameters.getAll(key).length!==1)) invalid();
  for (const key of SDK_METADATA) {
    if (parameters.has(key) && parameters.get(key).length>2048) invalid();
    parameters.delete(key);
  }
  const scopes=(parameters.get('scope') ?? '').split(' ').filter(Boolean);
  if (new Set(scopes).size!==scopes.length || ![2,3].includes(scopes.length)
    || !['openid','profile'].every(scope=>scopes.includes(scope))
    || scopes.some(scope=>!['openid','profile','offline_access'].includes(scope))) invalid();
  parameters.set('scope','openid profile');
  let claims;
  try { claims=JSON.parse(parameters.get('claims')); } catch { invalid(); }
  if (!claims || Object.keys(claims).join(',')!=='id_token' || !claims.id_token
    || typeof claims.id_token!=='object' || Array.isArray(claims.id_token)) invalid();
  for (const key of OPTIONAL_CLAIMS) {
    if (!Object.hasOwn(claims.id_token,key)) continue;
    const request=claims.id_token[key];
    if (!request || Object.keys(request).join(',')!=='essential' || request.essential!==false) invalid();
    delete claims.id_token[key];
  }
  if (Object.keys(claims.id_token).join(',')!=='auth_time'
    || !claims.id_token.auth_time || Object.keys(claims.id_token.auth_time).join(',')!=='essential'
    || claims.id_token.auth_time.essential!==true) invalid();
  parameters.set('claims',JSON.stringify({ id_token: { auth_time: { essential: true } } }));
  const expected={ client_id: endpoints.clientId,response_type: 'code',redirect_uri: endpoints.redirectUri,response_mode: 'query',
    scope: 'openid profile',state,nonce,code_challenge: codeChallenge,code_challenge_method: 'S256',prompt: 'login',max_age: '0',
    claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) };
  if ([...parameters.keys()].length!==Object.keys(expected).length
    || Object.entries(expected).some(([key,entry])=>parameters.get(key)!==entry)) invalid();
  return url.toString();
}
