import { ApiError } from '../api-error.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { EntraAuthenticationError } from '../identity/entra-errors.js';
import { checkedCustomerMicrosoftBrowserRedirect } from '../identity/customer-microsoft-authorization-url.js';
import { readCustomerMicrosoftTransactionCookie,serializeCustomerMicrosoftTransactionCookie,
  clearCustomerMicrosoftTransactionCookie } from '../identity/customer-microsoft-cookie.js';
import { readJsonObjectBody,validateExactObject } from '../security.js';
import { checkedCustomerSessionCookie,sendCustomerAuthenticationJson as send,
  assertEmptyAuthenticationBody,readCustomerFlowCsrf } from './customer-authentication-http-contract.js';
import { defineRouteModule } from './route-module.js';

const ROOT='/api/v1/auth/microsoft',TOKEN=/^[A-Za-z0-9_-]{43}$/,HASH=/^[a-f0-9]{64}$/;
const ROUTES=Object.freeze({
  [`${ROOT}/login`]: ['GET','customer_microsoft_login'],
  [`${ROOT}/callback`]: ['GET','customer_microsoft_callback'],
  [`${ROOT}/choices`]: ['GET','customer_microsoft_choices'],
  [`${ROOT}/selection`]: ['POST','customer_microsoft_selection'],
  [`${ROOT}/link/start`]: ['POST','customer_microsoft_link_start'],
  [`${ROOT}/link/confirmation`]: ['GET','customer_microsoft_link_confirmation'],
  [`${ROOT}/link/confirm`]: ['POST','customer_microsoft_link_confirm'],
});
const CALLBACK_KEYS=new Set(['code','state','session_state','error','error_description','error_codes',
  'timestamp','trace_id','correlation_id','error_uri']);
const outputInvalid=()=>{ throw new ApiError(500,'AUTHENTICATION_RESULT_INVALID'); };
function redirect(response,status,location) {
  response.statusCode=status;response.setHeader('Location',location);response.end();return status;
}
function authorizationUrl(value) {
  try { return checkedCustomerMicrosoftBrowserRedirect(value); } catch { outputInvalid(); }
}
function transactionCookie(value,{ verified=false }={}) {
  if (typeof value!=='string' || value.length>300) outputInvalid();
  const parsed=readCustomerMicrosoftTransactionCookie({ cookie: value.split(';')[0] });
  if (!parsed || value!==serializeCustomerMicrosoftTransactionCookie(parsed,
    { maxAgeSeconds: verified ? 300 : 600,sameSite: verified ? 'Strict' : 'Lax' })) outputInvalid();return value;
}
function csrfValue(value) { if (typeof value!=='string' || !HASH.test(value)) outputInvalid();return value; }
function rejected(result) { if (result?.status==='rejected') throw new ApiError(401,'AUTHENTICATION_REJECTED'); }
function callback(parsedUrl) {
  for (const [key,value] of parsedUrl.searchParams) {
    if (!CALLBACK_KEYS.has(key) || parsedUrl.searchParams.getAll(key).length!==1
      || value.length>(key==='code' ? 4096 : 1024)) throw new ApiError(400,'VALIDATION_FAILED');
  }
  const state=parsedUrl.searchParams.get('state'),code=parsedUrl.searchParams.get('code'),error=parsedUrl.searchParams.get('error');
  if (!TOKEN.test(state ?? '') || parsedUrl.hash || error!==null && (!/^[a-z][a-z0-9_]{1,63}$/.test(error) || code!==null)
    || error===null && (typeof code!=='string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(code))) {
    throw new ApiError(400,'VALIDATION_FAILED');
  }
  return { state,code: code ?? undefined,providerError: error };
}
function choices(result) {
  if (result?.status!=='membership_required' || !Array.isArray(result.items) || result.items.length>100) outputInvalid();
  const seen=new Set(),items=result.items.map(item=>{
    if (!isInternalUuid(item?.membershipId) || seen.has(item.membershipId.toLowerCase())
      || typeof item.displayName!=='string' || item.displayName.length<1 || item.displayName.length>160
      || /[\u0000-\u001f\u007f]/.test(item.displayName)) outputInvalid();
    seen.add(item.membershipId.toLowerCase());return { membershipId: item.membershipId.toLowerCase(),displayName: item.displayName };
  });return { status: 'membership_required',items,csrfToken: csrfValue(result.csrfToken) };
}

// Explicit opt-in transport. createApp supplies Host/target/rate/error/security
// guards before this module; the closed Demo may never compose it.
export function createCustomerMicrosoftAuthenticationRouteModule({ authenticationService,admissionService,sourceKey,
  sessionService,publicOrigin }={}) {
  let origin;try { origin=new URL(publicOrigin); } catch { throw new TypeError('CUSTOMER_MICROSOFT_HTTP_CONFIGURATION_INVALID'); }
  if (origin.protocol!=='https:' || origin.origin!==publicOrigin
    || ['startLogin','startLink','complete'].some(method=>typeof authenticationService?.[method]!=='function')
    || ['choices','select','linkConfirmation','confirmLink'].some(method=>typeof admissionService?.[method]!=='function')
    || typeof sourceKey?.fingerprint!=='function' || typeof sessionService?.resolvePrincipal!=='function') {
    throw new TypeError('CUSTOMER_MICROSOFT_HTTP_CONFIGURATION_INVALID');
  }
  return defineRouteModule({ id: 'customer-microsoft-authentication',
    routeKey: path=>Object.hasOwn(ROUTES,path) ? ROUTES[path][1] : null,
    createHandler({ principalGuard,maxBodyBytes,maxResponseBytes }={}) {
      if (typeof principalGuard?.require!=='function' || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('CUSTOMER_MICROSOFT_HTTP_CONFIGURATION_INVALID');
      }
      return async({ request,response,path,parsedUrl,requestId })=>{
        if (!Object.hasOwn(ROUTES,path)) return null;
        if (request.method!==ROUTES[path][0]) throw new ApiError(405,'METHOD_NOT_ALLOWED');
        const isCallback=path===`${ROOT}/callback`,mutation=request.method==='POST';
        if (!isCallback && (parsedUrl.search || parsedUrl.hash)) throw new ApiError(400,'VALIDATION_FAILED');
        if (!isCallback) {
          const site=request.headers['sec-fetch-site'];
          if (site!==undefined && site!=='same-origin' && !(site==='none' && path===`${ROOT}/login`)
            || request.headers.origin!==undefined && request.headers.origin!==publicOrigin
            || mutation && request.headers.origin!==publicOrigin) throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        }
        response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
        if (!mutation) await assertEmptyAuthenticationBody(request);
        if (path===`${ROOT}/login` || path===`${ROOT}/link/start`) {
          const linking=path===`${ROOT}/link/start`;
          const principal=linking ? await principalGuard.require(request,{ csrf: true }) : null;
          if (linking) validateExactObject(await readJsonObjectBody(request,{ maxBytes: Math.min(1024,maxBodyBytes) }),{ required: {} });
          const fingerprint=sourceKey.fingerprint(request.socket.remoteAddress);
          if (typeof fingerprint!=='string' || !HASH.test(fingerprint)) outputInvalid();
          let result;
          try { result=await authenticationService[linking ? 'startLink' : 'startLogin']({
            correlationId: requestId,sourceKey: fingerprint,...(linking ? { principal } : {}) }); }
          catch (error) { if (error instanceof EntraAuthenticationError) throw new ApiError(401,'AUTHENTICATION_REJECTED');throw error; }
          rejected(result);if (result?.status!=='redirect') outputInvalid();
          const url=authorizationUrl(result.authorizationUrl),cookie=transactionCookie(result.setCookie);
          response.setHeader('Set-Cookie',cookie);
          return linking ? send(response,200,{ authorizationUrl: url,requestId },maxResponseBytes) : redirect(response,302,url);
        }
        const cookie=readCustomerMicrosoftTransactionCookie(request.headers);
        if (isCallback) {
          response.setHeader('Set-Cookie',clearCustomerMicrosoftTransactionCookie());
          const protocol=callback(parsedUrl);
          if (!cookie) return redirect(response,303,'/?auth=authentication_failed');
          let result;
          try { result=await authenticationService.complete({ ...cookie,...protocol,correlationId: requestId,
            principal: await sessionService.resolvePrincipal(request) }); }
          catch (error) {
            if (error instanceof EntraAuthenticationError) return redirect(response,303,'/?auth=authentication_failed');throw error;
          }
          if (result?.status==='rejected') return redirect(response,303,'/?auth=authentication_failed');
          if (!['membership_required','link_confirmation_required'].includes(result?.status)) outputInvalid();
          response.setHeader('Set-Cookie',transactionCookie(result.setCookie,{ verified: true }));
          return redirect(response,303,result.status==='membership_required'
            ? '/?auth=microsoft_membership_required' : '/?auth=microsoft_link_confirmation_required');
        }
        if (!cookie) throw new ApiError(401,'AUTHENTICATION_REJECTED');
        if (path===`${ROOT}/choices`) {
          const result=await admissionService.choices(cookie);rejected(result);
          return send(response,200,{ ...choices(result),requestId },maxResponseBytes);
        }
        const principal=path===`${ROOT}/selection` ? null : await principalGuard.require(request);
        if (path===`${ROOT}/link/confirmation`) {
          const result=await admissionService.linkConfirmation({ ...cookie,principal });rejected(result);
          if (result?.status!=='link_confirmation_required') outputInvalid();
          return send(response,200,{ status: result.status,csrfToken: csrfValue(result.csrfToken),requestId },maxResponseBytes);
        }
        const csrfToken=readCustomerFlowCsrf(request),selection=path===`${ROOT}/selection`;
        const body=validateExactObject(await readJsonObjectBody(request,{ maxBytes: Math.min(1024,maxBodyBytes) }),
          { required: selection ? { membershipId: isInternalUuid } : { confirm: value=>value===true } });
        const context={ ...cookie,csrfToken,correlationId: requestId };
        const result=selection ? await admissionService.select(context,{ membershipId: body.membershipId })
          : await admissionService.confirmLink({ ...context,principal },{ confirm: true });
        rejected(result);if (result?.status!=='authenticated') outputInvalid();
        response.setHeader('Set-Cookie',[checkedCustomerSessionCookie(result.setCookie),clearCustomerMicrosoftTransactionCookie()]);
        response.statusCode=204;response.end();return 204;
      };
    },
  });
}
