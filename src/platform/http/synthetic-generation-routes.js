import { isInternalUuid,isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizeSyntheticGenerationDirectory,projectSyntheticGenerationReplacement }
  from '../../domain/synthetic-generation-directory.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { readPlatformPasskeyTransactionCookie,serializePlatformPasskeyTransactionCookie,clearPlatformPasskeyTransactionCookie }
  from '../identity/passkey-auth-cookie.js';
import { readPlatformPasskeyOperationCookie,serializePlatformPasskeyOperationCookie,clearPlatformPasskeyOperationCookie }
  from '../identity/passkey-operation-cookie.js';
import { definePlatformRouteModule } from './route-module.js';
import { PLATFORM_HTTP_ROUTE as ROUTE } from './observability.js';
import { PlatformHttpError } from './errors.js';
import { sendPlatformJson } from './response.js';
import { requireCommittedPlatformPasskeyOperation } from './passkey-operation-result.js';
import { assertNoPlatformRequestBody,readPlatformJsonObject,requirePlatformExactObject } from './security.js';

const ROOT='/api/v1/platform/synthetic/generation';
const ROUTES=Object.freeze({ [ROOT]: ['GET',ROUTE.SYNTHETIC_GENERATION_CURRENT],
  [`${ROOT}/options`]: ['POST',ROUTE.SYNTHETIC_GENERATION_OPTIONS],
  [`${ROOT}/replace`]: ['POST',ROUTE.SYNTHETIC_GENERATION_REPLACE] });
function invalid() { throw new PlatformHttpError(500,'PLATFORM_SYNTHETIC_GENERATION_RESULT_INVALID'); }
function denied() { throw new PlatformHttpError(403,'PLATFORM_SYNTHETIC_GENERATION_DENIED',{ securityCategory: 'authorization' }); }
async function call(work) {
  try { return await work(); } catch (error) {
    if (['SYNTHETIC_GENERATION_STALE','SYNTHETIC_GENERATION_COOLDOWN','SYNTHETIC_GENERATION_RETENTION_LIMIT'].includes(error?.message)) {
      throw new PlatformHttpError(409,`PLATFORM_${error.message}`);
    }
    if (['SYNTHETIC_GENERATION_DENIED','SYNTHETIC_GENERATION_AUTHORITY_DENIED'].includes(error?.message)) denied();
    if (['PROTECTED_RUNTIME_BUSY','PROTECTED_RUNTIME_SCOPE_STALE','PROTECTED_OPERATOR_SCOPE_STALE'].includes(error?.code)) {
      throw new PlatformHttpError(503,'PLATFORM_SYNTHETIC_GENERATION_UNAVAILABLE');
    }
    throw error;
  }
}

// Opt-in own-generation routes. Normal MFA may read only its own test metadata;
// create/reset requires a fresh exact assertion and owner-exclusive transaction.
// No browser operator/Tenant authority or ordinary real target scope is accepted.
export function createPlatformSyntheticGenerationRouteModule({ protocol,scope }={}) {
  if (['current','options','replace'].some(name=>typeof protocol?.[name]!=='function') || !scope
    || Object.keys(scope).sort().join(',')!=='environment,platformOrigin,platformSecurityEpoch,securityEpoch'
    || !['dev','int'].includes(scope.environment) || !isInternalUuid(scope.securityEpoch)
    || !Number.isSafeInteger(scope.platformSecurityEpoch) || scope.platformSecurityEpoch<1
    || typeof scope.platformOrigin!=='string' || scope.platformOrigin.length>253) {
    throw new TypeError('SYNTHETIC_GENERATION_HTTP_CONFIGURATION_INVALID');
  }
  let origin;try { origin=new URL(scope.platformOrigin); } catch {
    throw new TypeError('SYNTHETIC_GENERATION_HTTP_CONFIGURATION_INVALID');
  }
  if (origin.origin!==scope.platformOrigin || origin.protocol!=='https:') {
    throw new TypeError('SYNTHETIC_GENERATION_HTTP_CONFIGURATION_INVALID');
  }
  scope=Object.freeze({ ...scope,securityEpoch: scope.securityEpoch.toLowerCase() });
  return definePlatformRouteModule({ id: 'platform-synthetic-generation',
    claim: ({ path })=>Object.hasOwn(ROUTES,path) ? ROUTES[path][1] : null,
    createHandler({ platformPrincipalGuard,maxBodyBytes,maxResponseBytes }={}) {
      if (typeof platformPrincipalGuard?.require!=='function' || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes<1024
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) throw new TypeError('SYNTHETIC_GENERATION_HTTP_PORTS_INVALID');
      return async({ request,response,path,parsedUrl,requestId })=>{
        if (!Object.hasOwn(ROUTES,path)) return null;
        if (request.method!==ROUTES[path][0]) throw new PlatformHttpError(405,'PLATFORM_METHOD_NOT_ALLOWED');
        if (parsedUrl.search || parsedUrl.hash) throw new PlatformHttpError(400,'PLATFORM_VALIDATION_FAILED');
        const mutation=request.method==='POST',site=request.headers['sec-fetch-site'];
        if (site!==undefined && site!=='same-origin' || request.headers.origin!==undefined && request.headers.origin!==scope.platformOrigin
          || mutation && request.headers.origin!==scope.platformOrigin) denied();
        const replacement=path===`${ROOT}/replace`;let body=null;
        if (mutation) body=requirePlatformExactObject(await readPlatformJsonObject(request,{ maxBytes: Math.min(maxBodyBytes,16384) }),
          { required: { expectedGenerationId: value=>value===null || isInternalUuid(value),
            expectedRevision: value=>Number.isSafeInteger(value) && value>=0,
            ...(replacement ? { state: isOpaqueBrowserToken,
              response: value=>value!==null && typeof value==='object' && !Array.isArray(value) } : {}) } });
        else await assertNoPlatformRequestBody(request);
        if (body && (body.expectedGenerationId===null)!==(body.expectedRevision===0)) {
          throw new PlatformHttpError(400,'PLATFORM_VALIDATION_FAILED');
        }
        const principal=normalizePlatformPrincipal(
          await platformPrincipalGuard.require(request,{ csrf: mutation,correlationId: requestId }));
        if (principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER || principal.assurance.level!=='mfa'
          || principal.assurance.authenticationContext!=='cm:pk:v1'
          || principal.session.securityEpoch!==scope.platformSecurityEpoch) denied();
        response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
        if (!mutation) {
          const view=normalizeSyntheticGenerationDirectory(await call(()=>protocol.current({ principal,correlationId: requestId })));
          sendPlatformJson(response,200,{ ...view,requestId },maxResponseBytes);return 200;
        }
        const intent={ operatorId: principal.operatorId,expectedGenerationId: body.expectedGenerationId?.toLowerCase() ?? null,
          expectedRevision: body.expectedRevision };
        if (!replacement) {
          const result=await call(()=>protocol.options({ principal,intent,correlationId: requestId }));
          if (result?.status!=='passkey_required' || !isOpaqueBrowserToken(result.state) || !result.options
            || typeof result.options!=='object' || Array.isArray(result.options) || typeof result.setCookie!=='string') invalid();
          const cookie=readPlatformPasskeyTransactionCookie({ cookie: result.setCookie.split(';')[0] });
          if (!cookie || cookie.split('.')[0]!==result.state
            || result.setCookie!==serializePlatformPasskeyTransactionCookie(cookie,120)) invalid();
          response.setHeader('Set-Cookie',serializePlatformPasskeyOperationCookie(cookie));
          sendPlatformJson(response,200,{ status: result.status,state: result.state,options: result.options,requestId },maxResponseBytes);
          return 200;
        }
        const cookie=readPlatformPasskeyOperationCookie(request.headers);if (!cookie) denied();
        const result=await call(()=>protocol.replace({ principal,intent,correlationId: requestId,cookie,
          state: body.state,response: body.response,request }));
        const completed=requireCommittedPlatformPasskeyOperation(result,{ principal,securityEpoch: scope.platformSecurityEpoch });
        const generation=projectSyntheticGenerationReplacement(completed.result);
        // Validate the entire bounded public result before releasing cookies.
        const payload={ status: 'generation_replaced',generation,csrfToken: completed.csrfToken,requestId };
        if (Buffer.byteLength(JSON.stringify(payload))>maxResponseBytes) invalid();
        response.setHeader('Set-Cookie',
          [completed.normalCookie,clearPlatformPasskeyTransactionCookie(),clearPlatformPasskeyOperationCookie()]);
        sendPlatformJson(response,200,payload,maxResponseBytes);return 200;
      };
    },
  });
}
