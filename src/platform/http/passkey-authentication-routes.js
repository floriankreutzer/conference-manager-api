import { readPlatformEntraTransactionCookie } from '../identity/entra-transaction-cookie.js';
import { clearPlatformPasskeyTransactionCookie, readPlatformPasskeyTransactionCookie,
  serializePlatformPasskeyTransactionCookie } from '../identity/passkey-auth-cookie.js';
import { clearPlatformPasskeyEnrollmentCookie } from '../identity/passkey-enrollment-cookie.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { definePlatformRouteModule } from './route-module.js';
import { parsePlatformMicrosoftCallbackQuery } from './microsoft-callback-query.js';
import { PLATFORM_AUTH_LOGIN_PATH, PLATFORM_AUTH_CALLBACK_PATH } from './authentication-routes.js';
import { requirePlatformCookie, requirePlatformPrimaryAuthorizationUrl, requirePlatformResultRedirect,
  sendPlatformRedirect } from './response.js';
import { assertNoPlatformRequestBody, assertPlatformNoQuery } from './security.js';

function oidcCookie(value) {
  return requirePlatformCookie(value, { name: 'cm_platform_oidc_tx', path: PLATFORM_AUTH_CALLBACK_PATH, sameSite: 'Lax' });
}
function pendingCookie(value) {
  const cookie = typeof value === 'string' ? readPlatformPasskeyTransactionCookie({ cookie: value.split(';')[0] }) : null;
  if (!cookie || value !== serializePlatformPasskeyTransactionCookie(cookie, 120)) {
    throw new PlatformHttpError(500, 'PLATFORM_COOKIE_CONTRACT_INVALID');
  }
  return value;
}
function pendingResult(value) {
  const allowed = ['status','state','setCookie', ...(value?.status === 'passkey_required' ? ['options'] : [])];
  if (!value || !['passkey_required','enrollment_required'].includes(value.status)
    || Object.keys(value).sort().join(',') !== allowed.sort().join(',')
    || !/^[A-Za-z0-9_-]{43}$/.test(value.state || '')
    || (value.status === 'passkey_required' && (!value.options || typeof value.options !== 'object'))) {
    throw new PlatformHttpError(500, 'PLATFORM_AUTH_SERVICE_RESULT_INVALID');
  }
  const cookie = pendingCookie(value.setCookie);
  if (!cookie.startsWith(`cm_platform_passkey_tx=${value.state}.`)) {
    throw new PlatformHttpError(500, 'PLATFORM_COOKIE_CONTRACT_INVALID');
  }
  return cookie;
}

// Alternative to the CA route module, selected only by protected composition.
// A primary callback sets only a pending cookie; it cannot emit a session cookie.
export const platformPasskeyAuthenticationRoutes = definePlatformRouteModule({
  id: 'platform-passkey-microsoft-authentication',
  claim({ path }) {
    if (path === PLATFORM_AUTH_LOGIN_PATH) return PLATFORM_HTTP_ROUTE.AUTH_LOGIN;
    if (path === PLATFORM_AUTH_CALLBACK_PATH) return PLATFORM_HTTP_ROUTE.AUTH_CALLBACK;
    return null;
  },
  createHandler({ platformAuthService, platformEntraAuthority, platformEntraClientId, platformEntraRedirectUri,
    platformPublicOrigin, readTransactionCookie = readPlatformEntraTransactionCookie }) {
    if (!['start','complete','clearCookie'].every(name => typeof platformAuthService?.[name] === 'function')) {
      throw new TypeError('PLATFORM_AUTH_SERVICE_REQUIRED');
    }
    if (typeof readTransactionCookie !== 'function') throw new TypeError('PLATFORM_OIDC_COOKIE_READER_REQUIRED');
    const resultRedirect = requirePlatformResultRedirect(new URL('/', platformPublicOrigin).toString(), platformPublicOrigin);
    return async function handle({ path, parsedUrl, request, response, requestId }) {
      if (![PLATFORM_AUTH_LOGIN_PATH, PLATFORM_AUTH_CALLBACK_PATH].includes(path)) return null;
      if (request.method !== 'GET') throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      await assertNoPlatformRequestBody(request);
      if (path === PLATFORM_AUTH_LOGIN_PATH) {
        assertPlatformNoQuery(parsedUrl);
        const started = await platformAuthService.start({ purpose: 'login', correlationId: requestId });
        const location = requirePlatformPrimaryAuthorizationUrl(started?.authorizationUrl, { authority: platformEntraAuthority,
          clientId: platformEntraClientId, redirectUri: platformEntraRedirectUri, authenticationMaxAgeSeconds: 300 });
        response.setHeader('Set-Cookie', [oidcCookie(started.setCookie), clearPlatformPasskeyTransactionCookie(),
          clearPlatformPasskeyEnrollmentCookie()]);
        sendPlatformRedirect(response, location); return 303;
      }
      const cleared = oidcCookie(platformAuthService.clearCookie()); response.setHeader('Set-Cookie', cleared);
      const query = parsePlatformMicrosoftCallbackQuery(parsedUrl);
      try {
        const result = await platformAuthService.complete({ request, ...query,
          browserBinding: readTransactionCookie(request.headers), correlationId: requestId });
        if (result?.status !== 'authentication_rejected') response.setHeader('Set-Cookie', [cleared, pendingResult(result)]);
      } catch (error) {
        if (!['PlatformIdentityError','PlatformAuthenticationError'].includes(error?.name)) throw error;
      }
      sendPlatformRedirect(response, resultRedirect); return 303;
    };
  },
});
