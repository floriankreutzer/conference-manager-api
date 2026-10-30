import { createHash } from 'node:crypto';
import { isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { PLATFORM_MICROSOFT_OPERATION_CALLBACK,readPlatformMicrosoftOperationBrowserCookie,
  readPlatformMicrosoftOperationCookie,clearPlatformMicrosoftOperationBrowserCookie,clearPlatformMicrosoftOperationCookie }
  from '../identity/microsoft-operation-cookie.js';
import { definePlatformRouteModule } from './route-module.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE as ROUTE } from './observability.js';
import { parsePlatformMicrosoftCallbackQuery } from './microsoft-callback-query.js';
import { sendPlatformJson,sendPlatformRedirect,requirePlatformCookie } from './response.js';
import { assertNoPlatformRequestBody,assertPlatformNoQuery,readPlatformJsonObject,requirePlatformExactObject } from './security.js';

export const PLATFORM_MICROSOFT_OPERATION_STATUS='/api/v1/platform/auth/microsoft/operation/status';
export const PLATFORM_MICROSOFT_OPERATION_COMPLETE='/api/v1/platform/auth/microsoft/operation/complete';
export const PLATFORM_MICROSOFT_OPERATION_CONFIGURATION='/api/v1/platform/auth/microsoft/operation/configuration';
const CLOSE_SCRIPT='(()=>{const close=()=>{try{window.close();}catch{}};'
  +'document.getElementById("platformMicrosoftCloseWindow").addEventListener("click",close);close();})();';
const CLOSE_SCRIPT_HASH=createHash('sha256').update(CLOSE_SCRIPT).digest('base64');
const PAGE='<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
  +'<title>Microsoft-Bestätigung · Pavurel</title><main><h1>Zurück zur Anwendung</h1>'
  +'<p>Dieses Fenster schließt sich automatisch, sofern der Browser es erlaubt. '
  +'Falls es geöffnet bleibt, schließe es und kehre zum ursprünglichen Anwendungsfenster zurück. '
  +'Deine Auswahl und Eingaben bleiben dort erhalten. Die Anwendung prüft den Bestätigungsstatus selbst.</p>'
  +'<p lang="en">This window closes automatically where the browser permits it. '
  +'If it remains open, close it and return to the original application window. '
  +'Your selection and inputs remain there. The application independently checks the confirmation status.</p>'
  +'<button type="button" id="platformMicrosoftCloseWindow">Fenster schließen / '
  +'<span lang="en">Close window</span></button>'
  +'<p>Ist das ursprüngliche Fenster nicht mehr geöffnet? <a href="/platform-admin/">Plattform öffnen</a></p>'
  +'<p lang="en">Original window no longer open? <a href="/platform-admin/">Open platform</a></p>'
  +'</main><script>'+CLOSE_SCRIPT+'</script></html>';

// Callback owns only the Lax pending cookie; status/final requests still require
// the original Strict session and separate Strict operation cookie. No opener,
// postMessage, browser storage or generic operation endpoint. The completion
// page's hash-pinned close-only script is a navigation hint, never authority.
export function createPlatformMicrosoftOperationAuthenticationRoutes(service,{ environment }={}) {
  if (!['dev','int','prod'].includes(environment) || ['complete','pendingStatus'].some(name=>typeof service?.[name]!=='function')) {
    throw new TypeError('PLATFORM_MICROSOFT_OPERATION_SERVICE_REQUIRED');
  }
  return definePlatformRouteModule({ id: 'platform-microsoft-operation-authentication',
    claim({ path }) {
      if (path===PLATFORM_MICROSOFT_OPERATION_CALLBACK) return ROUTE.MICROSOFT_OPERATION_CALLBACK;
      if (path===PLATFORM_MICROSOFT_OPERATION_STATUS) return ROUTE.MICROSOFT_OPERATION_STATUS;
      if (path===PLATFORM_MICROSOFT_OPERATION_COMPLETE) return ROUTE.MICROSOFT_OPERATION_COMPLETE;
      if (path===PLATFORM_MICROSOFT_OPERATION_CONFIGURATION) return ROUTE.MICROSOFT_OPERATION_CONFIGURATION;
      return null;
    },
    createHandler({ platformPrincipalGuard,maxResponseBytes,maxBodyBytes }) {
      if (typeof platformPrincipalGuard?.require!=='function') throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
      return async context=>{
        const { path,request,response,parsedUrl,requestId }=context;
        if (![PLATFORM_MICROSOFT_OPERATION_CALLBACK,PLATFORM_MICROSOFT_OPERATION_STATUS,
          PLATFORM_MICROSOFT_OPERATION_COMPLETE,PLATFORM_MICROSOFT_OPERATION_CONFIGURATION].includes(path)) return null;
        response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
        if (request.method!==(path===PLATFORM_MICROSOFT_OPERATION_STATUS ? 'POST' : 'GET')) {
          throw new PlatformHttpError(405,'PLATFORM_METHOD_NOT_ALLOWED');
        }
        if (path===PLATFORM_MICROSOFT_OPERATION_CALLBACK) {
          await assertNoPlatformRequestBody(request);
          const cleared=[clearPlatformMicrosoftOperationBrowserCookie(),clearPlatformMicrosoftOperationCookie()];
          response.setHeader('Set-Cookie',cleared);
          try {
            const query=parsePlatformMicrosoftCallbackQuery(parsedUrl);
            const result=await service.complete({ state: query.state,
              ...(query.code===null ? { providerError: query.providerError } : { code: query.code }),
              cookie: readPlatformMicrosoftOperationBrowserCookie(request.headers) });
            if (!['operation_verified','authentication_rejected'].includes(result?.status)
              || !Array.isArray(result.setCookies) || result.setCookies.length!==2
              || result.principal!==undefined || result.csrfToken!==undefined) {
              throw new Error('PLATFORM_MICROSOFT_OPERATION_RESULT_INVALID');
            }
            response.setHeader('Set-Cookie',[
              requirePlatformCookie(result.setCookies[0],{ name: 'cm_platform_ms_operation_tx',
                path: PLATFORM_MICROSOFT_OPERATION_CALLBACK,sameSite: 'Lax' }),
              requirePlatformCookie(result.setCookies[1],{ name: 'cm_platform_ms_operation',path: '/api/v1/platform',sameSite: 'Strict' }),
            ]);
          } catch {
            // Always scrub provider query material. The fixed neutral page makes
            // no success claim; only the original source-bound status/final flow
            // can acknowledge verification or a committed business mutation.
            response.setHeader('Set-Cookie',cleared);
          }
          sendPlatformRedirect(response,PLATFORM_MICROSOFT_OPERATION_COMPLETE);return 303;
        }
        assertPlatformNoQuery(parsedUrl);
        if (path===PLATFORM_MICROSOFT_OPERATION_CONFIGURATION) {
          await assertNoPlatformRequestBody(request);
          await platformPrincipalGuard.require(request,{ correlationId: requestId });
          sendPlatformJson(response,200,{ mode: 'microsoft_mfa',environment },maxResponseBytes);return 200;
        }
        if (path===PLATFORM_MICROSOFT_OPERATION_COMPLETE) {
          await assertNoPlatformRequestBody(request);
          if (Buffer.byteLength(PAGE)>maxResponseBytes) throw new PlatformHttpError(500,'PLATFORM_RESPONSE_TOO_LARGE');
          response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'sha256-"+CLOSE_SCRIPT_HASH
            +"'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
          response.statusCode=200;response.setHeader('Content-Type','text/html; charset=utf-8');
          response.setHeader('Content-Length',Buffer.byteLength(PAGE));response.end(PAGE);return 200;
        }
        await platformPrincipalGuard.require(request,{ csrf: true,correlationId: requestId });
        const body=await readPlatformJsonObject(request,{ maxBytes: Math.min(maxBodyBytes,256) });
        requirePlatformExactObject(body,{ required: { state: isOpaqueBrowserToken } });
        let result;
        try { result=await service.pendingStatus({ state: body.state,request,
          cookie: readPlatformMicrosoftOperationCookie(request.headers) }); }
        catch (error) {
          if (error?.name!=='PlatformIdentityError') throw error;
          throw new PlatformHttpError(403,'PLATFORM_MICROSOFT_OPERATION_REJECTED',{ securityCategory: 'authorization' });
        }
        if (!['pending','verified'].includes(result?.status) || Object.keys(result).length!==1) {
          throw new Error('PLATFORM_MICROSOFT_OPERATION_RESULT_INVALID');
        }
        sendPlatformJson(response,200,{ status: result.status,requestId },maxResponseBytes);return 200;
      };
    },
  });
}
