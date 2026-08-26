import { ApiError, asApiError } from './api-error.js';
import { AuthorizationDeniedError } from './authorization/errors.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { assertProductionConfig } from './config.js';
import { isInternalUuid } from './domain/identifiers.js';
import {
  applicationRouteKey,
  createApplicationHttpHandler,
} from './http/application-routes.js';
import {
  createMicrosoft365HttpHandler,
  microsoft365RouteKey,
} from './http/microsoft365-routes.js';
import { EntraAuthenticationError } from './identity/entra-errors.js';
import { readEntraTransactionCookie } from './identity/entra-transaction-cookie.js';
import { createLogger } from './logger.js';
import { createHealthMonitor } from './observability/health.js';
import { createMetricsRegistry } from './observability/metrics.js';
import { readTenantClaimCookie } from './onboarding/claim-cookie.js';
import {
  applySecurityHeaders,
  assertAllowedMethod,
  assertRequestHost,
  assertSafeRequestTarget,
  assertSameOrigin,
  createPrincipalGuard,
  createRateLimiter,
  createRequestId,
  readJsonObjectBody,
  validateExactObject,
} from './security.js';
import { createTenantContextGuard } from './tenancy/tenant-context.js';

const ROUTES = Object.freeze({
  live: '/api/v1/health/live',
  ready: '/api/v1/health/ready',
  status: '/api/v1/health/status',
  entraLogin: '/api/v1/auth/microsoft/login',
  entraCallback: '/api/v1/auth/microsoft/callback',
  onboardingStart: '/api/v1/onboarding/invitations/start',
  onboardingClaim: '/api/v1/onboarding/claim',
  principal: '/api/v1/session',
  audit: '/api/v1/audit',
  tenantUsers: '/api/v1/tenant/users',
});
const REQUEST_PATH = /^\/api\/v1\/requests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const REQUEST_TRANSITION_PATH = /^\/api\/v1\/requests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/transitions$/;
const BOOKING_CHANGE_PATH = /^\/api\/v1\/requests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/booking-change$/;
const BOOKING_CHANGE_DECISION_PATH = new RegExp(
  '^/api/v1/requests/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/booking-change/([0-9a-f-]{36})/decision$',
  'i',
);
const TENANT_USER_ROLES_PATH = /^\/api\/v1\/tenant\/users\/([0-9a-f-]{36})\/roles$/i;
const ALLOWED_METRIC_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ELEVATED_TENANT_ROLES = new Set(['conference_manager', 'tenant_admin']);
const TRANSITION_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    transition: (value) => typeof value === 'string' && value.length >= 1 && value.length <= 32,
  }),
  optional: Object.freeze({
    reason: (value) => typeof value === 'string' && value.length <= 1000,
  }),
});
const BOOKING_CHANGE_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    roomId: (value) => typeof value === 'string' && value.length >= 1 && value.length <= 128,
    startsAt: (value) => typeof value === 'string' && value.length <= 64,
    endsAt: (value) => typeof value === 'string' && value.length <= 64,
    internalParticipants: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000,
    externalParticipants: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000,
  }),
  optional: Object.freeze({}),
});
const BOOKING_CHANGE_DECISION_SCHEMA = Object.freeze({
  required: Object.freeze({
    decision: (value) => value === 'approve' || value === 'reject',
  }),
  optional: Object.freeze({
    reason: (value) => typeof value === 'string' && value.length <= 1_000,
  }),
});
const ONBOARDING_START_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    invitationToken: (value) => typeof value === 'string' && INVITATION_TOKEN_PATTERN.test(value),
  }),
  optional: Object.freeze({}),
});
const ONBOARDING_CONFIRM_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({ confirm: (value) => value === true }),
  optional: Object.freeze({}),
});
const TENANT_USER_ROLES_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    roles: (value) => Array.isArray(value)
      && value.length <= 2
      && value.every((role) => typeof role === 'string' && ELEVATED_TENANT_ROLES.has(role)),
  }),
  optional: Object.freeze({}),
});
const AUDIT_QUERY_KEYS = new Set(['limit', 'beforeId']);
const TENANT_USERS_QUERY_KEYS = new Set(['limit', 'afterId']);
const ENTRA_CALLBACK_QUERY_KEYS = new Set([
  'code',
  'state',
  'session_state',
  'error',
  'error_description',
  'error_codes',
  'timestamp',
  'trace_id',
  'correlation_id',
  'error_uri',
]);

function urlOf(rawUrl, publicOrigin) {
  return new URL(rawUrl, publicOrigin);
}

function sendJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) throw new ApiError(500, 'RESPONSE_TOO_LARGE');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function sendNoContent(response) {
  response.statusCode = 204;
  response.removeHeader('Content-Type');
  response.removeHeader('Content-Length');
  response.end();
}

function sendRedirect(response, statusCode, location) {
  response.statusCode = statusCode;
  response.setHeader('Location', location);
  response.setHeader('Content-Length', '0');
  response.removeHeader('Content-Type');
  response.end();
}

function assertNoQuery(parsedUrl) {
  if ([...parsedUrl.searchParams.keys()].length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
}

function entraCallbackFromUrl(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!ENTRA_CALLBACK_QUERY_KEYS.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
  const state = parsedUrl.searchParams.get('state');
  const code = parsedUrl.searchParams.get('code');
  const error = parsedUrl.searchParams.get('error');
  if (typeof state !== 'string' || !state || state.length > 256) throw new ApiError(400, 'VALIDATION_FAILED');
  if (error !== null) {
    if (!error || error.length > 128 || code !== null) throw new ApiError(400, 'VALIDATION_FAILED');
    return Object.freeze({ state, providerError: true });
  }
  if (typeof code !== 'string' || !code || code.length > 4096) throw new ApiError(400, 'VALIDATION_FAILED');
  return Object.freeze({ state, code, providerError: false });
}

function publicRequest(request) {
  return Object.freeze({
    id: request.id,
    roomId: request.roomId,
    status: request.status,
    statusReason: request.statusReason,
    startsAt: request.startsAt,
    endsAt: request.endsAt,
    internalParticipants: request.internalParticipants,
    externalParticipants: request.externalParticipants,
    statusChangedAt: request.statusChangedAt,
    updatedAt: request.updatedAt,
  });
}

function publicAuditEvent(event) {
  return Object.freeze({
    id: event.id,
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    previousState: event.previousState,
    newState: event.newState,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    outcome: event.outcome,
    metadata: event.metadata,
    retentionClass: event.retentionClass,
  });
}

function auditPageFromUrl(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!AUDIT_QUERY_KEYS.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
  const limitValue = parsedUrl.searchParams.get('limit');
  const beforeId = parsedUrl.searchParams.get('beforeId');
  if (limitValue !== null && !/^\d{1,3}$/.test(limitValue)) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  return Object.freeze({
    limit: limitValue === null ? undefined : Number(limitValue),
    beforeId,
  });
}

function tenantUsersPageFromUrl(parsedUrl) {
  for (const key of parsedUrl.searchParams.keys()) {
    if (!TENANT_USERS_QUERY_KEYS.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
  }
  const limitValue = parsedUrl.searchParams.get('limit');
  const afterId = parsedUrl.searchParams.get('afterId');
  if (limitValue !== null && !/^\d{1,3}$/.test(limitValue)) {
    throw new ApiError(400, 'VALIDATION_FAILED');
  }
  if (afterId !== null && !isInternalUuid(afterId)) throw new ApiError(400, 'VALIDATION_FAILED');
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (limit < 1 || limit > 100)) throw new ApiError(400, 'VALIDATION_FAILED');
  return Object.freeze({ limit, afterUserId: afterId });
}

function routeKey(path) {
  if (path === ROUTES.live) return 'health_live';
  if (path === ROUTES.ready) return 'health_ready';
  if (path === ROUTES.status) return 'health_status';
  if (path === ROUTES.entraLogin) return 'entra_login';
  if (path === ROUTES.entraCallback) return 'entra_callback';
  if (path === ROUTES.onboardingStart) return 'onboarding_start';
  if (path === ROUTES.onboardingClaim) return 'onboarding_claim';
  if (path === ROUTES.principal) return 'session';
  if (path === ROUTES.audit) return 'audit';
  if (path === ROUTES.tenantUsers) return 'tenant_users';
  if (TENANT_USER_ROLES_PATH.test(path)) return 'tenant_user_roles';
  const applicationRoute = applicationRouteKey(path);
  if (applicationRoute) return applicationRoute;
  const microsoft365Route = microsoft365RouteKey(path);
  if (microsoft365Route) return microsoft365Route;
  if (REQUEST_TRANSITION_PATH.test(path)) return 'request_transition';
  if (BOOKING_CHANGE_DECISION_PATH.test(path)) return 'booking_change_decision';
  if (BOOKING_CHANGE_PATH.test(path)) return 'booking_change';
  if (REQUEST_PATH.test(path)) return 'request';
  return 'not_found';
}

function metricMethod(method) {
  return ALLOWED_METRIC_METHODS.has(method) ? method : 'OTHER';
}

export function createApp({
  config,
  readinessChecks = [],
  degradationChecks = [],
  authorizationPolicy = createAuthorizationPolicy(),
  auditService,
  sessionService,
  entraAuthService,
  onboardingService,
  requestService,
  bookingChangeService,
  productionApplicationService,
  tenantUserAdministrationService,
  microsoft365ConnectionService,
  resolvePrincipal,
  verifyCsrf,
  loadTenant,
  clientKey = (request) => request.socket.remoteAddress || 'unknown',
  logger = createLogger(),
  metrics = createMetricsRegistry(),
  clock = () => Date.now(),
} = {}) {
  if (!config) throw new TypeError('CONFIG_REQUIRED');
  assertProductionConfig(config);
  if (!authorizationPolicy || typeof authorizationPolicy.assertRecognizedPrincipal !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!metrics || typeof metrics.recordApiRequest !== 'function') {
    throw new TypeError('METRICS_REQUIRED');
  }

  const rateLimiter = createRateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
    clock,
  });
  const principalGuard = createPrincipalGuard({
    resolvePrincipal: resolvePrincipal || sessionService?.resolvePrincipal,
    verifyCsrf: verifyCsrf || sessionService?.verifyCsrf,
  });
  const tenantGuard = createTenantContextGuard({ loadTenant });
  const applicationHandler = createApplicationHttpHandler({
    service: productionApplicationService,
    principalGuard,
    tenantGuard,
    maxBodyBytes: config.maxBodyBytes,
    maxResponseBytes: config.maxResponseBytes,
  });
  const microsoft365Handler = createMicrosoft365HttpHandler({
    service: microsoft365ConnectionService,
    principalGuard,
    tenantGuard,
    maxBodyBytes: config.maxBodyBytes,
    maxResponseBytes: config.maxResponseBytes,
  });
  const healthMonitor = createHealthMonitor({
    readinessChecks,
    degradationChecks,
    timeoutMs: config.readinessTimeoutMs,
    metrics,
  });

  return async function handle(request, response) {
    const startedAt = clock();
    const requestId = createRequestId();
    response.setHeader('X-Request-Id', requestId);
    applySecurityHeaders(response, config);

    let statusCode = 500;
    let route = 'invalid_request';
    try {
      assertAllowedMethod(request.method);
      assertSafeRequestTarget(request.url);
      assertRequestHost(request.headers, config.publicOrigin);
      assertSameOrigin(request.headers, config.publicOrigin);
      rateLimiter.consume(clientKey(request));
      const parsedUrl = urlOf(request.url, config.publicOrigin);
      const path = parsedUrl.pathname;
      route = routeKey(path);

      if (path === ROUTES.live) {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        statusCode = 200;
        sendJson(response, statusCode, { status: 'ok', requestId }, config.maxResponseBytes);
        return;
      }

      if (path === ROUTES.ready || path === ROUTES.status) {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        const health = await healthMonitor.evaluate();
        logger.healthEvaluated({ requestId, status: health.status });
        if (path === ROUTES.ready) {
          statusCode = health.ready ? 200 : 503;
          sendJson(
            response,
            statusCode,
            { status: health.ready ? 'ready' : 'not_ready', requestId },
            config.maxResponseBytes,
          );
          return;
        }
        statusCode = health.ready ? 200 : 503;
        sendJson(response, statusCode, {
          status: health.status,
          service: {
            version: config.serviceVersion,
            buildId: config.buildId,
            environment: config.mode,
          },
          requestId,
        }, config.maxResponseBytes);
        return;
      }

      if (path === ROUTES.entraLogin) {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        assertNoQuery(parsedUrl);
        if (!entraAuthService || typeof entraAuthService.start !== 'function') {
          throw new ApiError(503, 'AUTHENTICATION_SERVICE_UNAVAILABLE');
        }
        const started = await entraAuthService.start({ correlationId: requestId });
        if (typeof started?.authorizationUrl !== 'string' || typeof started?.setCookie !== 'string') {
          throw new ApiError(500, 'AUTHENTICATION_RESULT_INVALID');
        }
        response.setHeader('Set-Cookie', started.setCookie);
        statusCode = 302;
        sendRedirect(response, statusCode, started.authorizationUrl);
        return;
      }

      if (path === ROUTES.onboardingStart) {
        if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        assertNoQuery(parsedUrl);
        if (!onboardingService || typeof onboardingService.beginInvitation !== 'function') {
          throw new ApiError(503, 'ONBOARDING_SERVICE_UNAVAILABLE');
        }
        if (!entraAuthService || typeof entraAuthService.start !== 'function') {
          throw new ApiError(503, 'AUTHENTICATION_SERVICE_UNAVAILABLE');
        }
        const body = validateExactObject(
          await readJsonObjectBody(request, { maxBytes: config.maxBodyBytes }),
          ONBOARDING_START_BODY_SCHEMA,
        );
        const invitation = await onboardingService.beginInvitation(body);
        const started = await entraAuthService.start({
          correlationId: requestId,
          onboardingInvitationId: invitation.invitationId,
        });
        if (typeof started?.authorizationUrl !== 'string' || typeof started?.setCookie !== 'string') {
          throw new ApiError(500, 'AUTHENTICATION_RESULT_INVALID');
        }
        response.setHeader('Set-Cookie', started.setCookie);
        statusCode = 200;
        sendJson(response, statusCode, { authorizationUrl: started.authorizationUrl, requestId }, config.maxResponseBytes);
        return;
      }

      if (path === ROUTES.entraCallback) {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        if (
          !entraAuthService
          || typeof entraAuthService.complete !== 'function'
          || typeof entraAuthService.clearCookie !== 'function'
        ) {
          throw new ApiError(503, 'AUTHENTICATION_SERVICE_UNAVAILABLE');
        }
        const callback = entraCallbackFromUrl(parsedUrl);
        const browserBinding = readEntraTransactionCookie(request.headers);
        const clearedTransactionCookie = entraAuthService.clearCookie();
        response.setHeader('Set-Cookie', clearedTransactionCookie);
        let completed;
        try {
          completed = await entraAuthService.complete({
            ...callback,
            browserBinding,
            correlationId: requestId,
          });
        } catch (error) {
          if (!(error instanceof EntraAuthenticationError)) throw error;
          metrics.recordAuthenticationFailure();
          logger.securityOutcome({ requestId, category: 'authentication' });
          statusCode = 303;
          sendRedirect(response, statusCode, '/?auth=authentication_failed');
          return;
        }
        if (completed.status === 'authentication_rejected') {
          metrics.recordAuthenticationFailure();
          logger.securityOutcome({ requestId, category: 'authentication' });
          statusCode = 303;
          sendRedirect(response, statusCode, '/?auth=authentication_failed');
          return;
        }
        if (completed.status === 'onboarding_required') {
          statusCode = 303;
          sendRedirect(response, statusCode, '/?auth=tenant_onboarding_required');
          return;
        }
        if (completed.status === 'claim_confirmation_required' && typeof completed.setCookie === 'string') {
          response.setHeader('Set-Cookie', [clearedTransactionCookie, completed.setCookie]);
          statusCode = 303;
          sendRedirect(response, statusCode, '/onboarding?auth=confirm');
          return;
        }
        if (completed.status !== 'authenticated' || typeof completed.setCookie !== 'string') {
          throw new ApiError(500, 'AUTHENTICATION_RESULT_INVALID');
        }
        response.setHeader('Set-Cookie', [clearedTransactionCookie, completed.setCookie]);
        statusCode = 303;
        sendRedirect(response, statusCode, '/');
        return;
      }

      if (path === ROUTES.onboardingClaim) {
        if (request.method !== 'GET' && request.method !== 'POST') {
          throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        }
        assertNoQuery(parsedUrl);
        if (
          !onboardingService
          || typeof onboardingService.claimStatus !== 'function'
          || typeof onboardingService.confirmClaim !== 'function'
          || typeof onboardingService.clearClaimCookie !== 'function'
        ) {
          throw new ApiError(503, 'ONBOARDING_SERVICE_UNAVAILABLE');
        }
        const claimToken = readTenantClaimCookie(request.headers);
        if (request.method === 'GET') {
          const claim = await onboardingService.claimStatus({ claimToken });
          statusCode = 200;
          sendJson(response, statusCode, {
            tenant: claim.tenant,
            expiresAt: claim.expiresAt,
            csrfToken: claim.csrfToken,
            requestId,
          }, config.maxResponseBytes);
          return;
        }
        validateExactObject(
          await readJsonObjectBody(request, { maxBytes: config.maxBodyBytes }),
          ONBOARDING_CONFIRM_BODY_SCHEMA,
        );
        const confirmed = await onboardingService.confirmClaim({
          claimToken,
          csrfToken: request.headers['x-csrf-token'],
          correlationId: requestId,
        });
        response.setHeader('Set-Cookie', onboardingService.clearClaimCookie());
        statusCode = 200;
        sendJson(response, statusCode, {
          status: confirmed.status,
          tenant: { status: confirmed.tenantStatus },
          requestId,
        }, config.maxResponseBytes);
        return;
      }

      if (path === ROUTES.principal) {
        if (request.method !== 'GET' && request.method !== 'DELETE') {
          throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        }
        const principal = await principalGuard.require(request, { csrf: request.method === 'DELETE' });
        const tenantContext = await tenantGuard.requireKnown(principal);

        if (request.method === 'DELETE') {
          if (!sessionService || typeof sessionService.revoke !== 'function') {
            throw new ApiError(503, 'SESSION_SERVICE_UNAVAILABLE');
          }
          await sessionService.revoke(principal, { correlationId: requestId });
          response.setHeader('Set-Cookie', sessionService.clearCookie());
          statusCode = 204;
          sendNoContent(response);
          return;
        }

        try {
          authorizationPolicy.assertRecognizedPrincipal(principal);
        } catch (error) {
          if (error instanceof AuthorizationDeniedError && auditService?.recordAuthorizationDenied) {
            await auditService.recordAuthorizationDenied({
              principal,
              tenantContext,
              correlationId: requestId,
              targetType: 'endpoint',
              targetId: 'session',
              metadata: { operation: 'read' },
            });
          }
          throw error;
        }
        const csrfToken = sessionService?.csrfTokenForPrincipal?.(principal);
        statusCode = 200;
        sendJson(response, statusCode, {
          user: { id: principal.userId },
          tenant: {
            id: tenantContext.tenantId,
            status: tenantContext.status,
          },
          roles: principal.roles,
          permissions: principal.permissions,
          session: { expiresAt: principal.session.expiresAt },
          ...(csrfToken ? { csrfToken } : {}),
          requestId,
        }, config.maxResponseBytes);
        return;
      }

      if (path === ROUTES.audit) {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        const principal = await principalGuard.require(request);
        const tenantContext = await tenantGuard.requireKnown(principal);
        if (!auditService || typeof auditService.listTenantEvents !== 'function') {
          throw new ApiError(503, 'AUDIT_SERVICE_UNAVAILABLE');
        }
        const page = auditPageFromUrl(parsedUrl);
        const events = await auditService.listTenantEvents({
          principal,
          tenantContext,
          correlationId: requestId,
          ...page,
        });
        const publicEvents = events.map(publicAuditEvent);
        statusCode = 200;
        sendJson(response, statusCode, {
          events: publicEvents,
          nextBeforeId: publicEvents.at(-1)?.id || null,
          requestId,
        }, config.maxResponseBytes);
        return;
      }

      const applicationStatus = await applicationHandler({
        request,
        response,
        parsedUrl,
        path,
        requestId,
      });
      if (applicationStatus !== null) {
        statusCode = applicationStatus;
        return;
      }

      const microsoft365Status = await microsoft365Handler({
        request,
        response,
        parsedUrl,
        path,
        requestId,
      });
      if (microsoft365Status !== null) {
        statusCode = microsoft365Status;
        return;
      }

      const tenantUserRoleMatch = path.match(TENANT_USER_ROLES_PATH);
      if (path === ROUTES.tenantUsers || tenantUserRoleMatch) {
        const isRoleMutation = Boolean(tenantUserRoleMatch);
        const expectedMethod = isRoleMutation ? 'PUT' : 'GET';
        if (request.method !== expectedMethod) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        if (!tenantUserAdministrationService) {
          throw new ApiError(503, 'TENANT_USER_SERVICE_UNAVAILABLE');
        }
        const principal = await principalGuard.require(request, { csrf: isRoleMutation });
        const tenantContext = await tenantGuard.requireKnown(principal);
        if (isRoleMutation) {
          assertNoQuery(parsedUrl);
          const body = validateExactObject(
            await readJsonObjectBody(request, { maxBytes: config.maxBodyBytes }),
            TENANT_USER_ROLES_BODY_SCHEMA,
          );
          const user = await tenantUserAdministrationService.setRoles({
            principal,
            tenantContext,
            targetUserId: tenantUserRoleMatch[1],
            roles: body.roles,
            correlationId: requestId,
          });
          statusCode = 200;
          sendJson(response, statusCode, { user, requestId }, config.maxResponseBytes);
          return;
        }
        const page = tenantUsersPageFromUrl(parsedUrl);
        const users = await tenantUserAdministrationService.listUsers({
          principal,
          tenantContext,
          correlationId: requestId,
          ...page,
        });
        const effectiveLimit = page.limit ?? 100;
        statusCode = 200;
        sendJson(response, statusCode, {
          users,
          nextAfterId: users.length === effectiveLimit ? users.at(-1)?.id || null : null,
          requestId,
        }, config.maxResponseBytes);
        return;
      }

      const transitionMatch = path.match(REQUEST_TRANSITION_PATH);
      const bookingChangeMatch = path.match(BOOKING_CHANGE_PATH);
      const bookingChangeDecisionMatch = path.match(BOOKING_CHANGE_DECISION_PATH);
      if (bookingChangeMatch || bookingChangeDecisionMatch) {
        const mutation = request.method !== 'GET';
        if (bookingChangeDecisionMatch && request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        if (bookingChangeMatch && !['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        const principal = await principalGuard.require(request, { csrf: mutation });
        authorizationPolicy.assertRecognizedPrincipal(principal);
        const tenantContext = await tenantGuard.requireActive(principal);
        if (!bookingChangeService) throw new ApiError(503, 'BOOKING_CHANGE_SERVICE_UNAVAILABLE');
        const requestIdValue = (bookingChangeDecisionMatch || bookingChangeMatch)[1];
        if (bookingChangeDecisionMatch) {
          const body = validateExactObject(
            await readJsonObjectBody(request, { maxBytes: config.maxBodyBytes }),
            BOOKING_CHANGE_DECISION_SCHEMA,
          );
          if (
            body.decision === 'approve' && body.reason !== undefined
            || body.decision === 'reject' && body.reason === undefined
          ) throw new ApiError(400, 'VALIDATION_FAILED');
          const result = body.decision === 'approve'
            ? await bookingChangeService.approve({
              principal, tenantContext, correlationId: requestId, requestId: requestIdValue,
              changeId: bookingChangeDecisionMatch[2].toLowerCase(),
            })
            : await bookingChangeService.reject({
              principal, tenantContext, correlationId: requestId, requestId: requestIdValue,
              changeId: bookingChangeDecisionMatch[2].toLowerCase(), rejectionReason: body.reason,
            });
          statusCode = 200;
          sendJson(response, statusCode, {
            schemaVersion: 1,
            result: result.request ? { ...result, request: publicRequest(result.request) } : result,
          }, config.maxResponseBytes);
          return;
        }
        const result = request.method === 'GET'
          ? { change: await bookingChangeService.findOpen({
            principal, tenantContext, correlationId: requestId, requestId: requestIdValue,
          }) }
          : await bookingChangeService.propose({
            principal, tenantContext, correlationId: requestId, requestId: requestIdValue,
            proposed: validateExactObject(
              await readJsonObjectBody(request, { maxBytes: config.maxBodyBytes }),
              BOOKING_CHANGE_BODY_SCHEMA,
            ),
          });
        statusCode = request.method === 'POST' ? 201 : 200;
        sendJson(response, statusCode, {
          schemaVersion: 1,
          result: result.request ? { ...result, request: publicRequest(result.request) } : result,
        }, config.maxResponseBytes);
        return;
      }
      const requestMatch = path.match(REQUEST_PATH);
      if (transitionMatch || requestMatch) {
        const isTransition = Boolean(transitionMatch);
        const expectedMethod = isTransition ? 'POST' : 'GET';
        if (request.method !== expectedMethod) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        const principal = await principalGuard.require(request, { csrf: isTransition });
        authorizationPolicy.assertRecognizedPrincipal(principal);
        const tenantContext = await tenantGuard.requireActive(principal);
        if (!requestService) throw new ApiError(503, 'REQUEST_SERVICE_UNAVAILABLE');
        const requestIdValue = (transitionMatch || requestMatch)[1];

        const record = isTransition
          ? await requestService.transitionRequest({
            principal,
            tenantContext,
            requestId: requestIdValue,
            correlationId: requestId,
            ...validateExactObject(
              await readJsonObjectBody(request, { maxBytes: config.maxBodyBytes }),
              TRANSITION_BODY_SCHEMA,
            ),
          })
          : await requestService.getRequest({
            principal,
            tenantContext,
            requestId: requestIdValue,
            correlationId: requestId,
          });
        statusCode = 200;
        sendJson(response, statusCode, { request: publicRequest(record), requestId }, config.maxResponseBytes);
        return;
      }

      throw new ApiError(404, 'NOT_FOUND');
    } catch (error) {
      const apiError = asApiError(error);
      statusCode = apiError.statusCode;
      if (statusCode === 401) {
        metrics.recordAuthenticationFailure();
        logger.securityOutcome({ requestId, category: 'authentication' });
      } else if (statusCode === 403) {
        metrics.recordAuthorizationDenied();
        logger.securityOutcome({ requestId, category: 'authorization' });
      }
      if (statusCode === 500) {
        logger.unhandledError({ requestId, errorName: error?.name || 'Error' });
      }
      if (!response.headersSent) {
        sendJson(response, statusCode, {
          error: {
            code: apiError.code,
            requestId,
            ...(apiError.context || {}),
          },
        }, config.maxResponseBytes);
      } else {
        response.destroy();
      }
    } finally {
      const durationMs = Math.max(0, clock() - startedAt);
      metrics.recordApiRequest({
        route,
        method: metricMethod(request.method),
        statusCode,
        durationMs,
      });
      logger.requestCompleted({
        requestId,
        method: request.method,
        route,
        statusCode,
        durationMs,
      });
    }
  };
}
