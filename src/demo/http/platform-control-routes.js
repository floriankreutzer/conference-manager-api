import {
  PLATFORM_PERMISSION,
  createPlatformAuthorizationPolicy,
} from '../../platform/identity/policy.js';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_OUTCOME,
  PLATFORM_AUDIT_RETENTION,
  normalizePlatformAuditEvent,
} from '../../platform/audit/event.js';
import { PlatformHttpError } from '../../platform/http/errors.js';
import { PlatformAuthorizationError } from '../../platform/identity/errors.js';
import { PLATFORM_HTTP_ROUTE } from '../../platform/http/observability.js';
import { definePlatformRouteModule } from '../../platform/http/route-module.js';
import {
  requirePlatformCookie,
  sendPlatformJson,
} from '../../platform/http/response.js';
import {
  assertNoPlatformRequestBody,
  assertPlatformNoQuery,
  readPlatformJsonObject,
  requirePlatformExactObject,
} from '../../platform/http/security.js';

export const DEMO_PLATFORM_SESSION_PATH = '/api/v1/platform/demo/session';
export const DEMO_PLATFORM_PERSONA_PATH = '/api/v1/platform/demo/session/persona';
export const DEMO_PLATFORM_RESET_PATH = '/api/v1/platform/demo/reset';

const PERSONA_SCHEMA = Object.freeze({
  required: Object.freeze({
    persona: (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{1,31}$/.test(value),
  }),
  optional: Object.freeze({}),
});
const RESET_SCHEMA = Object.freeze({
  required: Object.freeze({ confirm: (value) => value === true }),
  optional: Object.freeze({}),
});

function resetActor(principal) {
  return Object.freeze({
    operatorId: principal.operatorId,
    roles: principal.roles,
    permissions: principal.permissions,
    assuranceLevel: principal.assurance.level,
  });
}

function resetAuthority(principal) {
  return Object.freeze({
    operatorId: principal.operatorId,
    sessionId: principal.session.id,
    securityVersion: principal.securityVersion,
  });
}

function resetAuditEvent({ actor, correlationId, outcome, reasonCode, seedVersion }) {
  const failed = outcome !== PLATFORM_AUDIT_OUTCOME.SUCCESS;
  return normalizePlatformAuditEvent({
    ...actor,
    targetTenantId: null,
    action: outcome === PLATFORM_AUDIT_OUTCOME.DENIED
      ? PLATFORM_AUDIT_ACTION.AUTHORIZATION_DENIED
      : PLATFORM_AUDIT_ACTION.RECOVERY_EXECUTED,
    targetType: 'demo_runtime',
    targetId: 'shared_demo',
    previousState: null,
    newState: failed ? null : { seedVersion },
    occurredAt: new Date().toISOString(),
    correlationId,
    outcome,
    metadata: Object.freeze({
      operation: 'reset',
      ...(reasonCode === null ? {} : { reasonCode }),
    }),
    retentionClass: failed
      ? PLATFORM_AUDIT_RETENTION.SECURITY
      : PLATFORM_AUDIT_RETENTION.RECOVERY,
  });
}

function sessionCookie(value) {
  return requirePlatformCookie(value, {
    name: 'cm_platform_session',
    path: '/api/v1/platform',
    sameSite: 'Strict',
  });
}

function sessionProjection(result, requestId) {
  const { principal, persona, csrfToken } = result;
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
    demo: Object.freeze({ persona: persona.persona }),
    requestId,
  });
}

function normalizePersonaError(error) {
  if (
    error?.message === 'DEMO_PLATFORM_SESSION_INVALID'
    || error?.message === 'DEMO_PLATFORM_SESSION_AUTHORITY_INVALID'
  ) {
    return new PlatformHttpError(401, 'PLATFORM_AUTHENTICATION_FAILED', {
      securityCategory: 'authentication',
    });
  }
  if (error?.message === 'DEMO_PLATFORM_PERSONA_INVALID') {
    return new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  if (error?.message === 'DEMO_PLATFORM_PERSONA_NOT_AVAILABLE') {
    return new PlatformHttpError(404, 'PLATFORM_DEMO_PERSONA_NOT_AVAILABLE');
  }
  return error;
}

export function createDemoPlatformControlRoutes({
  personaService,
  resetService,
  authorizationPolicy = createPlatformAuthorizationPolicy(),
} = {}) {
  if (
    !personaService
    || typeof personaService.establish !== 'function'
    || typeof personaService.switch !== 'function'
  ) throw new TypeError('DEMO_PLATFORM_PERSONA_SERVICE_REQUIRED');
  if (!resetService || typeof resetService.reset !== 'function') {
    throw new TypeError('DEMO_RESET_SERVICE_REQUIRED');
  }

  return definePlatformRouteModule({
    id: 'platform-demo-control',
    claim({ path }) {
      if (path === DEMO_PLATFORM_SESSION_PATH) return PLATFORM_HTTP_ROUTE.DEMO_SESSION;
      if (path === DEMO_PLATFORM_PERSONA_PATH) return PLATFORM_HTTP_ROUTE.DEMO_PERSONA;
      if (path === DEMO_PLATFORM_RESET_PATH) return PLATFORM_HTTP_ROUTE.DEMO_RESET;
      return null;
    },
    createHandler({
      platformPrincipalGuard,
      platformAuditService,
      platformSessionService,
      maxBodyBytes,
      maxResponseBytes,
    }) {
      return async function handle({ request, response, parsedUrl, path, requestId }) {
        if (
          path !== DEMO_PLATFORM_SESSION_PATH
          && path !== DEMO_PLATFORM_PERSONA_PATH
          && path !== DEMO_PLATFORM_RESET_PATH
        ) return null;
        assertPlatformNoQuery(parsedUrl);

        if (path === DEMO_PLATFORM_SESSION_PATH) {
          if (request.method !== 'GET') {
            throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
          }
          await assertNoPlatformRequestBody(request);
          let result;
          try {
            result = await personaService.establish(request, { correlationId: requestId });
          } catch (error) {
            throw normalizePersonaError(error);
          }
          if (result.setCookie) response.setHeader('Set-Cookie', sessionCookie(result.setCookie));
          sendPlatformJson(response, 200, sessionProjection(result, requestId), maxResponseBytes);
          return 200;
        }

        const principal = await platformPrincipalGuard.require(request, {
          csrf: true,
          correlationId: requestId,
        });
        if (path === DEMO_PLATFORM_PERSONA_PATH) {
          if (request.method !== 'PUT') {
            throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
          }
          const body = requirePlatformExactObject(
            await readPlatformJsonObject(request, { maxBytes: maxBodyBytes }),
            PERSONA_SCHEMA,
          );
          let result;
          try {
            result = await personaService.switch(principal, {
              ...body,
              correlationId: requestId,
            });
          } catch (error) {
            throw normalizePersonaError(error);
          }
          response.setHeader('Set-Cookie', sessionCookie(result.setCookie));
          sendPlatformJson(response, 200, sessionProjection(result, requestId), maxResponseBytes);
          return 200;
        }

        if (request.method !== 'POST') {
          throw new PlatformHttpError(405, 'PLATFORM_METHOD_NOT_ALLOWED');
        }
        requirePlatformExactObject(
          await readPlatformJsonObject(request, { maxBytes: maxBodyBytes }),
          RESET_SCHEMA,
        );
        const actor = resetActor(principal);
        try {
          authorizationPolicy.authorize(principal, PLATFORM_PERMISSION.RECOVERY_EXECUTE);
        } catch (error) {
          if (error instanceof PlatformAuthorizationError) {
            await platformAuditService.record(resetAuditEvent({
              actor,
              correlationId: requestId,
              outcome: PLATFORM_AUDIT_OUTCOME.DENIED,
              reasonCode: 'permission_denied',
              seedVersion: resetService.descriptor?.seedVersion || 'shared_demo',
            }));
          }
          throw error;
        }
        const reset = await resetService.reset({
          actor,
          authority: resetAuthority(principal),
          correlationId: requestId,
          auditEventFor: resetAuditEvent,
        });
        response.setHeader('Set-Cookie', sessionCookie(platformSessionService.clearCookie()));
        sendPlatformJson(response, 200, {
          seedVersion: reset.seedVersion,
          checksum: reset.checksum,
          requestId,
        }, maxResponseBytes);
        return 200;
      };
    },
  });
}
