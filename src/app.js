import { ApiError, asApiError } from './api-error.js';
import { AuthorizationDeniedError } from './authorization/errors.js';
import { createAuthorizationPolicy } from './authorization/policy.js';
import { assertProductionConfig } from './config.js';
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
import { createLogger } from './logger.js';
import { createTenantContextGuard } from './tenancy/tenant-context.js';

const ROUTES = Object.freeze({
  live: '/api/v1/health/live',
  ready: '/api/v1/health/ready',
  principal: '/api/v1/session',
  audit: '/api/v1/audit',
});
const REQUEST_PATH = /^\/api\/v1\/requests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const REQUEST_TRANSITION_PATH = /^\/api\/v1\/requests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/transitions$/;
const TRANSITION_BODY_SCHEMA = Object.freeze({
  required: Object.freeze({
    transition: (value) => typeof value === 'string' && value.length >= 1 && value.length <= 32,
  }),
  optional: Object.freeze({
    reason: (value) => typeof value === 'string' && value.length <= 1000,
  }),
});
const AUDIT_QUERY_KEYS = new Set(['limit', 'beforeId']);

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

async function withTimeout(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('READINESS_TIMEOUT')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function isReady(checks, timeoutMs) {
  const results = await Promise.allSettled(checks.map((check) => withTimeout(check, timeoutMs)));
  return results.every((result) => result.status === 'fulfilled' && result.value === true);
}

export function createApp({
  config,
  readinessChecks = [],
  authorizationPolicy = createAuthorizationPolicy(),
  auditService,
  sessionService,
  requestService,
  resolvePrincipal,
  verifyCsrf,
  loadTenant,
  clientKey = (request) => request.socket.remoteAddress || 'unknown',
  logger = createLogger(),
  clock = () => Date.now(),
} = {}) {
  if (!config) throw new TypeError('CONFIG_REQUIRED');
  assertProductionConfig(config);
  if (!Array.isArray(readinessChecks) || readinessChecks.some((check) => typeof check !== 'function')) {
    throw new TypeError('READINESS_CHECKS_INVALID');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.assertRecognizedPrincipal !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
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

  return async function handle(request, response) {
    const startedAt = clock();
    const requestId = createRequestId();
    response.setHeader('X-Request-Id', requestId);
    applySecurityHeaders(response, config);

    let statusCode = 500;
    let path = '/';
    try {
      assertAllowedMethod(request.method);
      assertSafeRequestTarget(request.url);
      assertRequestHost(request.headers, config.publicOrigin);
      assertSameOrigin(request.headers, config.publicOrigin);
      rateLimiter.consume(clientKey(request));
      const parsedUrl = urlOf(request.url, config.publicOrigin);
      path = parsedUrl.pathname;

      if (path === ROUTES.live) {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        statusCode = 200;
        sendJson(response, statusCode, { status: 'ok', requestId }, config.maxResponseBytes);
        return;
      }

      if (path === ROUTES.ready) {
        if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        const ready = await isReady(readinessChecks, config.readinessTimeoutMs);
        statusCode = ready ? 200 : 503;
        sendJson(response, statusCode, { status: ready ? 'ready' : 'not_ready', requestId }, config.maxResponseBytes);
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

      const transitionMatch = path.match(REQUEST_TRANSITION_PATH);
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
      if (statusCode === 500) {
        logger.unhandledError({ requestId, errorName: error?.name || 'Error' });
      }
      if (!response.headersSent) {
        sendJson(response, statusCode, { error: { code: apiError.code, requestId } }, config.maxResponseBytes);
      } else {
        response.destroy();
      }
    } finally {
      logger.requestCompleted({
        requestId,
        method: request.method,
        path,
        statusCode,
        durationMs: Math.max(0, clock() - startedAt),
      });
    }
  };
}
