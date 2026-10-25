import { createSyntheticOperationTransport } from './synthetic-operation-transport.js';
import { BrowserNavigationFormError,isBrowserNavigationForm,readBrowserNavigationForm }
  from '../../transport/browser-navigation-form.js';
import { isInternalUuid,isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { normalizeOwnerCustomerAccessScope,requireOwnerCustomerAccessRedirect,OWNER_CUSTOMER_ACCESS_ROLES }
  from '../../domain/owner-customer-handoff.js';
import { normalizeSyntheticHandoffScope,requireSyntheticHandoffCustomerRedirect,SYNTHETIC_HANDOFF_ROLES,SYNTHETIC_HANDOFF_SLOTS }
  from '../../domain/synthetic-handoff.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { definePlatformRouteModule } from './route-module.js';
import { PLATFORM_HTTP_ROUTE as ROUTE } from './observability.js';
import { PlatformHttpError } from './errors.js';
import { sendPlatformJson,sendPlatformRedirect } from './response.js';
import { assertNoPlatformRequestBody,readPlatformJsonObject,requirePlatformExactObject } from './security.js';

// The signed intent may arrive without a Strict normal-MFA cookie. Arrival only
// preserves/scrubs that intent; all confirmation/options/approval require actual
// current normal passkey MFA, and mutations also require normal session CSRF.
// Protocol ports must be supplied by the owned protected composition; no route,
// fake provider, shared lease or privileged authority is activated by default.
export function createPlatformCustomerHandoffRouteModule({ protocol,intentCookie,scope,assuranceMode='application_passkey',
  directory=null,kind }={}) {
  if (!['synthetic','owner_real'].includes(kind)) throw new TypeError('PLATFORM_HANDOFF_HTTP_KIND_INVALID');
  const legacy=kind==='synthetic',errorPrefix=legacy ? 'PLATFORM_SYNTHETIC' : 'PLATFORM_OWNER_CUSTOMER';
  if (!legacy && (assuranceMode!=='microsoft_mfa' || typeof directory?.list!=='function')) {
    throw new TypeError('PLATFORM_OWNER_CUSTOMER_HTTP_CONFIGURATION_INVALID');
  }
const ROOT=legacy ? '/api/v1/platform/auth/delegation' : '/api/v1/platform/auth/owner';
const ROUTES=Object.freeze({
  [`${ROOT}/arrive`]: ['GET',ROUTE[legacy ? 'SYNTHETIC_ARRIVE' : 'OWNER_CUSTOMER_ARRIVE']],
  [`${ROOT}/intent`]: ['GET',ROUTE[legacy ? 'SYNTHETIC_INTENT' : 'OWNER_CUSTOMER_INTENT']],
  [`${ROOT}/options`]: ['POST',ROUTE[legacy ? 'SYNTHETIC_OPTIONS' : 'OWNER_CUSTOMER_OPTIONS']],
  [`${ROOT}/approve`]: ['POST',ROUTE[legacy ? 'SYNTHETIC_APPROVE' : 'OWNER_CUSTOMER_APPROVE']],
});
function invalid() { throw new PlatformHttpError(500,`${errorPrefix}_RESULT_INVALID`); }
function denied() { throw new PlatformHttpError(403,`${errorPrefix}_ACCESS_DENIED`,{ securityCategory: 'authorization' }); }
async function callProtocol(work) {
  try { return await work(); } catch (error) {
    if (error instanceof BrowserNavigationFormError) throw new PlatformHttpError(error.statusCode,`PLATFORM_${error.code}`);
    if (error?.message===(legacy ? 'SYNTHETIC_HANDOFF_DENIED' : 'OWNER_HANDOFF_DENIED')) denied();
    if (error?.message===(legacy ? 'SYNTHETIC_HANDOFF_OWNER_CAPACITY' : 'OWNER_HANDOFF_CAPACITY')
      || !legacy && error?.message==='OWNER_HANDOFF_BUSY'
      || ['PROTECTED_RUNTIME_BUSY','PROTECTED_RUNTIME_SCOPE_STALE'].includes(error?.code)) {
      throw new PlatformHttpError(503,`${errorPrefix}_UNAVAILABLE`);
    }
    throw error;
  }
}
function current(value,scope,normalContext) {
  const principal=normalizePlatformPrincipal(value);
  if (principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER || principal.assurance.level!=='mfa'
    || principal.assurance.authenticationContext!==normalContext || principal.session.securityEpoch!==scope.platformSecurityEpoch) denied();
  return principal;
}
function customerRedirect(value,intent,scope) {
  try {
    return (legacy ? requireSyntheticHandoffCustomerRedirect : requireOwnerCustomerAccessRedirect)(scope,value,intent.state);
  } catch { invalid(); }
}

  scope=legacy ? normalizeSyntheticHandoffScope(scope) : normalizeOwnerCustomerAccessScope(scope);
  const transport=createSyntheticOperationTransport({ assuranceMode,platformOrigin: scope.platformOrigin,
    securityEpoch: scope.platformSecurityEpoch });
  if (['options','approve'].some(name=>typeof protocol?.[name]!=='function')
    || ['issue','read','clear'].some(name=>typeof intentCookie?.[name]!=='function')) {
    throw new TypeError(legacy ? 'PLATFORM_SYNTHETIC_HTTP_CONFIGURATION_INVALID'
          : 'PLATFORM_OWNER_CUSTOMER_HTTP_CONFIGURATION_INVALID');
  }
  return definePlatformRouteModule({ id: legacy ? 'platform-synthetic-handoff' : 'platform-owner-customer-handoff',
    claim: ({ path })=>Object.hasOwn(ROUTES,path) ? ROUTES[path][1] : null,
    createHandler(runtime={}) {
      const { platformPrincipalGuard,maxBodyBytes,maxResponseBytes }=runtime;
      if (typeof platformPrincipalGuard?.require!=='function' || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
        throw new TypeError(legacy ? 'PLATFORM_SYNTHETIC_HTTP_CONFIGURATION_INVALID'
          : 'PLATFORM_OWNER_CUSTOMER_HTTP_CONFIGURATION_INVALID');
      }
      return async({ request,response,path,parsedUrl,requestId })=>{
        if (!Object.hasOwn(ROUTES,path)) return null;
        if (request.method!==ROUTES[path][0]) throw new PlatformHttpError(405,'PLATFORM_METHOD_NOT_ALLOWED');
        response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
        if (path===`${ROOT}/arrive`) {
          await assertNoPlatformRequestBody(request);
          const keys=[...parsedUrl.searchParams.keys()],flowId=parsedUrl.searchParams.get('flow'),state=parsedUrl.searchParams.get('state');
          if (parsedUrl.hash || keys.length!==2 || !keys.every(key=>['flow','state'].includes(key))
            || parsedUrl.searchParams.getAll('flow').length!==1 || parsedUrl.searchParams.getAll('state').length!==1
            || !isInternalUuid(flowId) || !isOpaqueBrowserToken(state)) {
            response.setHeader('Set-Cookie',intentCookie.clear());
            sendPlatformRedirect(response,'/?auth=authentication_failed');return 303;
          }
          response.setHeader('Set-Cookie',intentCookie.issue({ flowId: flowId.toLowerCase(),state }));
          sendPlatformRedirect(response,legacy ? '/?auth=synthetic_intent' : '/?auth=owner_intent');return 303;
        }
        const afterTenantId=parsedUrl.searchParams.get('afterTenantId');
        const ownerPage=!legacy && path===`${ROOT}/intent` && parsedUrl.searchParams.size===1
          && parsedUrl.searchParams.getAll('afterTenantId').length===1 && isInternalUuid(afterTenantId);
        if (parsedUrl.hash || parsedUrl.search && !ownerPage) throw new PlatformHttpError(400,'PLATFORM_VALIDATION_FAILED');
        const mutation=request.method==='POST',site=request.headers['sec-fetch-site'];
        if (site!==undefined && site!=='same-origin'
          || request.headers.origin!==undefined && request.headers.origin!==scope.platformOrigin
          || mutation && request.headers.origin!==scope.platformOrigin) denied();
        if (!mutation) await assertNoPlatformRequestBody(request);
        const approval=path===`${ROOT}/approve`;let form=null,payload=null;
        if (approval && isBrowserNavigationForm(request.headers)) {
          if (request.headers['x-csrf-token']!==undefined) throw new PlatformHttpError(400,'PLATFORM_VALIDATION_FAILED');
          form=await callProtocol(()=>readBrowserNavigationForm(request,{ keys: ['csrfToken','payload'],
            maxBytes: Math.min(maxBodyBytes,32768) }));
          if (!isOpaqueBrowserToken(form.csrfToken) || form.payload.length>16384) denied();
          try { payload=JSON.parse(form.payload); } catch { throw new PlatformHttpError(400,'PLATFORM_VALIDATION_FAILED'); }
        }
        const guardRequest=form ? { method: request.method,headers: { ...request.headers,'x-csrf-token': form.csrfToken } } : request;
        const principal=current(await platformPrincipalGuard.require(guardRequest,{ csrf: mutation,correlationId: requestId }),
          scope,transport.normalContext);
        const pending=intentCookie.read(request.headers);
        if (path===`${ROOT}/intent`) {
          // A normal authenticated startup can resume a signed intent after
          // Microsoft/passkey login has scrubbed the old presentation query.
          // Absent/invalid intent returns no grant or selected target.
          if (!pending) {
            sendPlatformJson(response,200,{ status: 'none',...(!legacy ? {
              customerStartUrl: scope.customerOrigin+'/?auth=owner_start',
            } : {}),requestId },maxResponseBytes);return 200;
          }
          if (!legacy) {
            const targets=await callProtocol(()=>directory.list({ principal,afterTenantId }));
            if (!targets || Object.keys(targets).sort().join(',')!=='nextTenantId,tenants'
              || !Array.isArray(targets.tenants) || targets.tenants.length>50
              || targets.nextTenantId!==null && !isInternalUuid(targets.nextTenantId)
              || targets.tenants.some(target=>!target || Object.keys(target).sort().join(',')!=='displayName,status,tenantId'
                || !isInternalUuid(target.tenantId) || typeof target.displayName!=='string' || target.displayName.trim().length<1
                || target.displayName.length>200 || /[\u0000-\u001f\u007f]/.test(target.displayName)
                || !['pending','onboarding','ready','active'].includes(target.status))) invalid();
            sendPlatformJson(response,200,{ status: 'confirmation_required',...targets,roles: [...OWNER_CUSTOMER_ACCESS_ROLES],
              customerStartUrl: scope.customerOrigin+'/?auth=owner_start',requestId },maxResponseBytes);return 200;
          }
          sendPlatformJson(response,200,{ status: 'confirmation_required',slots: [...SYNTHETIC_HANDOFF_SLOTS],
            roles: [...SYNTHETIC_HANDOFF_ROLES],requestId },maxResponseBytes);return 200;
        }
        if (!pending) denied();
        const body=requirePlatformExactObject(form ? payload
          : await readPlatformJsonObject(request,{ maxBytes: Math.min(maxBodyBytes,16384) }),
          { required: { ...(legacy ? { generationId: isInternalUuid,slot: value=>SYNTHETIC_HANDOFF_SLOTS.includes(value) }
            : { tenantId: isInternalUuid }),
            role: value=>(legacy ? SYNTHETIC_HANDOFF_ROLES : OWNER_CUSTOMER_ACCESS_ROLES).includes(value),...(approval ? {
              state: isOpaqueBrowserToken,
              ...(!transport.microsoft ? { response: value=>value!==null && typeof value==='object' && !Array.isArray(value) } : {}),
            } : {}) } });
        const intent={ ...pending,operatorId: principal.operatorId,role: body.role,
          ...(legacy ? { generationId: body.generationId.toLowerCase(),slot: body.slot } : { tenantId: body.tenantId.toLowerCase() }) };
        if (!approval) {
          const result=await callProtocol(()=>protocol.options({ principal,intent,correlationId: requestId }));
          const challenge=transport.challenge(result,requestId,runtime);
          response.setHeader('Set-Cookie',challenge.cookies);
          sendPlatformJson(response,200,challenge.payload,maxResponseBytes);
          return 200;
        }
        const cookie=transport.readCookie(request.headers);if (!cookie) denied();
        const completed=await callProtocol(()=>protocol.approve({ principal,intent,correlationId: requestId,cookie,state: body.state,
          ...(legacy ? { response: body.response } : {}),request }));
        const committed=transport.committed(completed,principal);
        if (committed.result?.status!=='redirect') invalid();
        const location=customerRedirect(committed.result.location,intent,scope),normal=committed.normalCookie;
        response.setHeader('Set-Cookie',[normal,...transport.clearCookies(),intentCookie.clear()]);
        sendPlatformRedirect(response,location);return 303;
      };
    },
  });
}
