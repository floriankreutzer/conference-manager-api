import { hasSessionCookie,serializeClearedSessionCookie } from '../identity/session-cookie.js';
import { BrowserNavigationFormError,isBrowserNavigationForm,readBrowserNavigationForm }
  from '../transport/browser-navigation-form.js';
import { ApiError } from '../api-error.js';
import { normalizeSyntheticHandoffScope,SYNTHETIC_HANDOFF_ROLES,SYNTHETIC_HANDOFF_SLOTS } from '../domain/synthetic-handoff.js';
import { isCustomerEmailBrowserToken } from '../identity/customer-email-browser-token.js';
import { SYNTHETIC_HANDOFF_COOKIE_PATH as ROOT,readSyntheticHandoffBrowserCookie,readSyntheticHandoffCompletionCookie,
  serializeSyntheticHandoffBrowserCookie,serializeSyntheticHandoffCompletionCookie,clearSyntheticHandoffCookies }
  from '../identity/synthetic-handoff-cookie.js';
import { readJsonObjectBody,validateExactObject } from '../security.js';
import { checkedCustomerSessionCookie,sendCustomerAuthenticationJson,assertEmptyAuthenticationBody,readCustomerFlowCsrf }
  from './customer-authentication-http-contract.js';
import { defineRouteModule } from './route-module.js';

const ROUTES=Object.freeze({
  [`${ROOT}/start`]: ['POST','synthetic_customer_start'],
  [`${ROOT}/callback`]: ['GET','synthetic_customer_callback'],
  [`${ROOT}/confirmation`]: ['GET','synthetic_customer_confirmation'],
  [`${ROOT}/complete`]: ['POST','synthetic_customer_complete'],
  [`${ROOT}/logout`]: ['POST','synthetic_customer_logout'],
});
function invalid() { throw new ApiError(500,'AUTHENTICATION_RESULT_INVALID'); }
function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!==keys.sort().join(',')) invalid();
}
function lifetime(value,maximum,clock) {
  if (typeof value!=='string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString()!==value) invalid();
  const seconds=Math.ceil((Date.parse(value)-clock())/1000);
  if (!Number.isSafeInteger(seconds) || seconds<1 || seconds>maximum+60) invalid();return Math.min(seconds,maximum);
}
function redirect(response,location) {
  response.statusCode=303;response.setHeader('Location',location);response.end();return 303;
}
function mapFailure(error) {
  if (error instanceof BrowserNavigationFormError) return new ApiError(error.statusCode,error.code);
  if (error?.message==='SYNTHETIC_HANDOFF_DENIED') return new ApiError(401,'AUTHENTICATION_REJECTED');
  if (error?.message==='SYNTHETIC_HANDOFF_LOGOUT_REQUIRED') return new ApiError(409,'AUTHENTICATION_LOGOUT_REQUIRED');
  if (['PROTECTED_RUNTIME_BUSY','PROTECTED_RUNTIME_SCOPE_STALE'].includes(error?.code)) {
    return new ApiError(503,'AUTHENTICATION_UNAVAILABLE');
  }
  return error;
}
async function call(work) { try { return await work(); } catch (error) { throw mapFailure(error); } }

// Opt-in only. The owning app retains its Host/target/rate/security/error gates.
// Callback GET creates only a short Strict completion cookie and scrubs the URL;
// final same-origin POST sees the ordinary Customer cookie before account change.
export function createSyntheticCustomerHandoffRouteModule({ service,scope,clock=Date.now }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  if (['start','callback','confirmation','complete','logout'].some(name=>typeof service?.[name]!=='function')
    || typeof clock!=='function') {
    throw new TypeError('SYNTHETIC_CUSTOMER_HTTP_CONFIGURATION_INVALID');
  }
  return defineRouteModule({ id: 'synthetic-customer-handoff',
    routeKey: path=>Object.hasOwn(ROUTES,path) ? ROUTES[path][1] : null,
    createHandler({ maxBodyBytes,maxResponseBytes }={}) {
      if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError('SYNTHETIC_CUSTOMER_HTTP_CONFIGURATION_INVALID');
      }
      return async({ request,response,path,parsedUrl,requestId })=>{
        if (!Object.hasOwn(ROUTES,path)) return null;
        if (request.method!==ROUTES[path][0]) throw new ApiError(405,'METHOD_NOT_ALLOWED');
        const callback=path===`${ROOT}/callback`,mutation=request.method==='POST';
        response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
        if (callback) {
          try {
            await assertEmptyAuthenticationBody(request);
            const keys=[...parsedUrl.searchParams.keys()];
            if (parsedUrl.hash || keys.length!==2 || !['state','code'].every(key=>parsedUrl.searchParams.getAll(key).length===1)
              || !keys.every(key=>['state','code'].includes(key))) throw new ApiError(400,'VALIDATION_FAILED');
            const state=parsedUrl.searchParams.get('state'),code=parsedUrl.searchParams.get('code');
            if (!isCustomerEmailBrowserToken(state) || !isCustomerEmailBrowserToken(code)) throw new ApiError(400,'VALIDATION_FAILED');
            const browser=readSyntheticHandoffBrowserCookie(request.headers);
            if (!browser) throw new ApiError(401,'AUTHENTICATION_REJECTED');
            const result=await call(()=>service.callback({ ...browser,state,code }));
            exact(result,['status','completion','expiresAt']);if (result.status!=='confirmation') invalid();
            response.setHeader('Set-Cookie',serializeSyntheticHandoffCompletionCookie(result.completion,
              lifetime(result.expiresAt,30,clock)));
            return redirect(response,'/?auth=synthetic_confirmation');
          } catch (error) {
            if (!(error instanceof ApiError) || ![400,401].includes(error.statusCode)) throw error;
            response.setHeader('Set-Cookie',clearSyntheticHandoffCookies());
            return redirect(response,'/?auth=authentication_failed');
          }
        }
        if (parsedUrl.search || parsedUrl.hash) throw new ApiError(400,'VALIDATION_FAILED');
        const site=request.headers['sec-fetch-site'];
        if (site!==undefined && site!=='same-origin'
          || request.headers.origin!==undefined && request.headers.origin!==scope.customerOrigin
          || mutation && request.headers.origin!==scope.customerOrigin) throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
        let form=null;
        if (mutation && isBrowserNavigationForm(request.headers)) {
          if (path===`${ROOT}/logout`) throw new ApiError(415,'UNSUPPORTED_MEDIA_TYPE');
          if (request.headers['x-csrf-token']!==undefined) throw new ApiError(400,'VALIDATION_FAILED');
          form=await call(()=>readBrowserNavigationForm(request,{ keys: path===`${ROOT}/start` ? [] : ['csrfToken'],
            maxBytes: Math.min(1024,maxBodyBytes) }));
        } else if (mutation) {
          validateExactObject(await readJsonObjectBody(request,{ maxBytes: Math.min(1024,maxBodyBytes) }),{ required: {} });
        } else await assertEmptyAuthenticationBody(request);
        if (path===`${ROOT}/start`) {
          const result=await call(()=>service.start(request.socket.remoteAddress));
          if (result?.status==='limited') { response.setHeader('Retry-After','60');throw new ApiError(429,'RATE_LIMITED'); }
          if (['busy','capacity'].includes(result?.status)) throw new ApiError(503,'AUTHENTICATION_UNAVAILABLE');
          exact(result,['status','flowId','state','browserToken','expiresAt']);
          if (result.status!=='started' || !isCustomerEmailBrowserToken(result.state)) invalid();
          const cookie=serializeSyntheticHandoffBrowserCookie(result,lifetime(result.expiresAt,600,clock));
          const location=new URL('/api/v1/platform/auth/delegation/arrive',scope.platformOrigin);
          location.searchParams.set('flow',result.flowId);location.searchParams.set('state',result.state);
          response.setHeader('Set-Cookie',[cookie,clearSyntheticHandoffCookies()[1]]);
          return redirect(response,location.href);
        }
        const browser=readSyntheticHandoffBrowserCookie(request.headers),completion=readSyntheticHandoffCompletionCookie(request.headers);
        if (!browser || !completion) throw new ApiError(401,'AUTHENTICATION_REJECTED');
        if (path===`${ROOT}/confirmation`) {
          const result=await call(()=>service.confirmation({ ...browser,completion }));exact(result,['slot','role','csrfToken']);
          if (!SYNTHETIC_HANDOFF_SLOTS.includes(result.slot) || !SYNTHETIC_HANDOFF_ROLES.includes(result.role)
            || typeof result.csrfToken!=='string' || !/^[a-f0-9]{64}$/.test(result.csrfToken)) invalid();
          return sendCustomerAuthenticationJson(response,200,{ ...result,
            accountSwitchRequired: hasSessionCookie(request.headers),requestId },maxResponseBytes);
        }
        const csrfToken=readCustomerFlowCsrf(form ? { headers: { 'x-csrf-token': form.csrfToken } } : request);
        if (path===`${ROOT}/logout`) {
          const result=await call(()=>service.logout({ ...browser,completion,csrfToken,request,correlationId: requestId }));
          exact(result,['setCookie']);if (result.setCookie!==serializeClearedSessionCookie({ secure: true })) invalid();
          response.setHeader('Set-Cookie',result.setCookie);response.statusCode=204;response.end();return 204;
        }
        const result=await call(()=>service.complete({ ...browser,completion,csrfToken,request,correlationId: requestId }));
        exact(result,['principal','csrfToken','setCookie']);
        response.setHeader('Set-Cookie',[checkedCustomerSessionCookie(result.setCookie),...clearSyntheticHandoffCookies()]);
        return redirect(response,'/');
      };
    },
  });
}
