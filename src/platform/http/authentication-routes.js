import { readPlatformEntraTransactionCookie } from '../identity/entra-transaction-cookie.js';
import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { definePlatformRouteModule } from './route-module.js';
import {
  requirePlatformCookie,
  requirePlatformProviderAuthorizationUrl,
  requirePlatformResultRedirect,
  sendPlatformRedirect,
} from './response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
} from './security.js';

export const PLATFORM_AUTH_LOGIN_PATH = '/api/v1/platform/auth/microsoft/login';
export const PLATFORM_AUTH_STEP_UP_PATH = '/api/v1/platform/auth/microsoft/step-up';
export const PLATFORM_AUTH_CALLBACK_PATH = '/api/v1/platform/auth/microsoft/callback';

const OPAQUE_VALUE = /^[A-Za-z0-9_-]{43}$/;
const AUTHORIZATION_CODE = /^[A-Za-z0-9._~-]{1,4096}$/;
const PROVIDER_ERROR = /^[a-z][a-z0-9_]{1,63}$/;

function callbackQuery(parsedUrl) {
  const keys = [...parsedUrl.searchParams.keys()];
  if (
    keys.some((key) => !['state', 'code', 'error'].includes(key))
    || keys.some((key) => parsedUrl.searchParams.getAll(key).length !== 1)
  ) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  const state = parsedUrl.searchParams.get('state');
  const code = parsedUrl.searchParams.get('code');
  const providerError = parsedUrl.searchParams.get('error');
  if (
    !OPAQUE_VALUE.test(state || '')
    || ((code === null) === (providerError === null))
    || (code !== null && !AUTHORIZATION_CODE.test(code))
    || (providerError !== null && !PROVIDER_ERROR.test(providerError))
  ) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  return Object.freeze({ state, code, providerError });
}

function isAuthenticationRejection(error) {
  return error?.name === 'PlatformIdentityError' || error?.name === 'PlatformAuthenticationError';
}

function transactionCookie(value) {
  return requirePlatformCookie(value, {
    name: 'cm_platform_oidc_tx',
    path: PLATFORM_AUTH_CALLBACK_PATH,
    sameSite: 'Lax',
  });
}

function sessionCookie(value) {
  return requirePlatformCookie(value, {
    name: 'cm_platform_session',
    path: '/api/v1/platform',
    sameSite: 'Strict',
  });
}

export const platformAuthenticationRoutes = definePlatformRouteModule({
  id: 'platform-authentication',
  claim({ path }) {
    if (path === PLATFORM_AUTH_LOGIN_PATH) return PLATFORM_HTTP_ROUTE.AUTH_LOGIN;
    if (path === PLATFORM_AUTH_STEP_UP_PATH) return PLATFORM_HTTP_ROUTE.AUTH_STEP_UP;
    if (path === PLATFORM_AUTH_CALLBACK_PATH) return PLATFORM_HTTP_ROUTE.AUTH_CALLBACK;
    return null;
  },
  createHandler({
    platformAuthService,
    platformEntraAuthority,
    platformEntraClientId,
    platformEntraRedirectUri,
    platformAuthenticationContexts,
    platformAuthenticationMaxAgeSeconds,
    platformPublicOrigin,
    platformPrincipalGuard,
    readTransactionCookie = readPlatformEntraTransactionCookie,
  }) {
    if (
      !platformAuthService
      || typeof platformAuthService.start !== 'function'
      || typeof platformAuthService.complete !== 'function'
      || typeof platformAuthService.clearCookie !== 'function'
    ) {
      throw new TypeError('PLATFORM_AUTH_SERVICE_REQUIRED');
    }
    if (typeof readTransactionCookie !== 'function') {
      throw new TypeError('PLATFORM_OIDC_COOKIE_READER_REQUIRED');
    }
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }
    const resultRedirect = requirePlatformResultRedirect(
      new URL('/', platformPublicOrigin).toString(),
      platformPublicOrigin,
    );

    return async function handle({ path, parsedUrl, request, response, requestId }) {
      if (
        path !== PLATFORM_AUTH_LOGIN_PATH
        && path !== PLATFORM_AUTH_STEP_UP_PATH
        && path !== PLATFORM_AUTH_CALLBACK_PATH
      ) return null;
      if (request.method !== 'GET') {
        throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      }

      if (path === PLATFORM_AUTH_LOGIN_PATH || path === PLATFORM_AUTH_STEP_UP_PATH) {
        assertPlatformNoQuery(parsedUrl);
        const purpose = path === PLATFORM_AUTH_LOGIN_PATH ? 'login' : 'step_up';
        const principal = purpose === 'step_up'
          ? await platformPrincipalGuard.require(request, { correlationId: requestId })
          : undefined;
        await assertNoPlatformRequestBody(request);
        const result = await platformAuthService.start({
          purpose,
          ...(principal ? { principal } : {}),
          correlationId: requestId,
        });
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new PlatformHttpError(500, 'PLATFORM_AUTH_SERVICE_RESULT_INVALID');
        }
        response.setHeader('Set-Cookie', transactionCookie(result.setCookie));
        sendPlatformRedirect(
          response,
          requirePlatformProviderAuthorizationUrl(result.authorizationUrl, platformEntraAuthority, {
            clientId: platformEntraClientId,
            redirectUri: platformEntraRedirectUri,
            authenticationContext: purpose === 'step_up'
              ? platformAuthenticationContexts[1]
              : platformAuthenticationContexts[0],
            authenticationMaxAgeSeconds: purpose === 'step_up'
              ? 0
              : platformAuthenticationMaxAgeSeconds,
          }),
        );
        return 303;
      }

      await assertNoPlatformRequestBody(request);
      const clearedCookie = transactionCookie(platformAuthService.clearCookie());
      response.setHeader('Set-Cookie', clearedCookie);
      const query = callbackQuery(parsedUrl);
      try {
        const result = await platformAuthService.complete({
          request,
          ...query,
          browserBinding: readTransactionCookie(request.headers),
          correlationId: requestId,
        });
        if (result?.status === 'authentication_rejected') {
          sendPlatformRedirect(response, resultRedirect);
          return 303;
        }
        if (
          result?.status !== 'authenticated'
          || !result.principal
          || typeof result.csrfToken !== 'string'
          || !OPAQUE_VALUE.test(result.csrfToken)
        ) {
          throw new PlatformHttpError(500, 'PLATFORM_AUTH_SERVICE_RESULT_INVALID');
        }
        response.setHeader('Set-Cookie', [clearedCookie, sessionCookie(result.setCookie)]);
        sendPlatformRedirect(response, resultRedirect);
        return 303;
      } catch (error) {
        if (!isAuthenticationRejection(error)) throw error;
        sendPlatformRedirect(response, resultRedirect);
        return 303;
      }
    };
  },
});
