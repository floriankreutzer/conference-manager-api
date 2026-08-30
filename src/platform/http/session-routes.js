import { PlatformHttpError } from './errors.js';
import { PLATFORM_HTTP_ROUTE } from './observability.js';
import { definePlatformRouteModule } from './route-module.js';
import {
  requirePlatformCookie,
  sendPlatformJson,
  sendPlatformNoContent,
} from './response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
} from './security.js';

export const PLATFORM_SESSION_PATH = '/api/v1/platform/session';
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sessionProjection(principal, csrfToken) {
  if (!CSRF_TOKEN_PATTERN.test(csrfToken || '')) {
    throw new PlatformHttpError(500, 'PLATFORM_SESSION_PROJECTION_INVALID');
  }
  return Object.freeze({
    operatorId: principal.operatorId,
    roles: principal.roles,
    permissions: principal.permissions,
    assurance: Object.freeze({
      level: principal.assurance.level,
      authenticatedAt: principal.assurance.authenticatedAt,
    }),
    expiresAt: principal.session.expiresAt,
    stepUpExpiresAt: principal.session.stepUpExpiresAt,
    csrfToken,
  });
}

function clearedSessionCookie(value) {
  return requirePlatformCookie(value, {
    name: 'cm_platform_session',
    path: '/api/v1/platform',
    sameSite: 'Strict',
  });
}

export const platformSessionRoutes = definePlatformRouteModule({
  id: 'platform-session',
  claim({ path }) {
    return path === PLATFORM_SESSION_PATH ? PLATFORM_HTTP_ROUTE.SESSION : null;
  },
  createHandler({
    platformSessionService,
    platformPrincipalGuard,
    maxResponseBytes,
  }) {
    if (
      !platformSessionService
      || typeof platformSessionService.csrfTokenForPrincipal !== 'function'
      || typeof platformSessionService.revoke !== 'function'
      || typeof platformSessionService.clearCookie !== 'function'
    ) {
      throw new TypeError('PLATFORM_SESSION_SERVICE_REQUIRED');
    }
    if (!platformPrincipalGuard || typeof platformPrincipalGuard.require !== 'function') {
      throw new TypeError('PLATFORM_PRINCIPAL_GUARD_REQUIRED');
    }

    return async function handle({ path, parsedUrl, request, response, requestId }) {
      if (path !== PLATFORM_SESSION_PATH) return null;
      if (!['GET', 'DELETE'].includes(request.method)) {
        throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
      }
      assertPlatformNoQuery(parsedUrl);

      if (request.method === 'GET') {
        const principal = await platformPrincipalGuard.require(request, { correlationId: requestId });
        await assertNoPlatformRequestBody(request);
        const csrfToken = platformSessionService.csrfTokenForPrincipal(principal);
        sendPlatformJson(response, 200, sessionProjection(principal, csrfToken), maxResponseBytes);
        return 200;
      }

      const principal = await platformPrincipalGuard.require(request, {
        csrf: true,
        correlationId: requestId,
      });
      await assertNoPlatformRequestBody(request);
      response.setHeader('Set-Cookie', clearedSessionCookie(platformSessionService.clearCookie()));
      const revoked = await platformSessionService.revoke(principal, { correlationId: requestId });
      if (revoked !== true && revoked !== false) {
        throw new PlatformHttpError(500, 'PLATFORM_SESSION_REVOKE_RESULT_INVALID');
      }
      sendPlatformNoContent(response);
      return 204;
    };
  },
});
