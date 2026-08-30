import { isInternalUuid } from '../domain/identifiers.js';
import { assertPlatformHttpConfig } from './config.js';
import { asPlatformHttpError, PlatformHttpError } from './http/errors.js';
import { platformAuthenticationRoutes } from './http/authentication-routes.js';
import { platformAuditRoutes } from './http/audit-routes.js';
import { platformDiagnosticRoutes } from './http/diagnostic-routes.js';
import { platformEntitlementRoutes } from './http/entitlement-routes.js';
import { platformHealthRoutes } from './http/health-routes.js';
import { platformMeteringRoutes } from './http/metering-routes.js';
import { platformMicrosoftHealthRoutes } from './http/microsoft-health-routes.js';
import {
  createPlatformLogger,
  NOOP_PLATFORM_METRICS,
  PLATFORM_HTTP_ROUTE,
  recordPlatformRequestCompletionSafely,
} from './http/observability.js';
import { createPlatformPrincipalGuard } from './http/principal-guard.js';
import { platformReadinessRoutes } from './http/readiness-routes.js';
import { platformRecoveryRoutes } from './http/recovery-routes.js';
import { createPlatformRouteRegistry } from './http/route-module.js';
import { sendPlatformJson } from './http/response.js';
import {
  applyPlatformSecurityHeaders,
  assertPlatformMethod,
  assertPlatformRequestHost,
  assertPlatformRequestOrigin,
  assertPlatformRequestTarget,
  createPlatformRateLimiter,
  createPlatformRequestId,
  isPlatformUnsafeMethod,
} from './http/security.js';
import { platformSessionRoutes } from './http/session-routes.js';
import { platformTenantRoutes } from './http/tenant-routes.js';
import { platformRuntimeRoutes } from './http/runtime-routes.js';

export const PLATFORM_OPERATIONAL_ROUTE_MODULES = Object.freeze([
  platformHealthRoutes,
  platformSessionRoutes,
  platformTenantRoutes,
  platformReadinessRoutes,
  platformEntitlementRoutes,
  platformMicrosoftHealthRoutes,
  platformDiagnosticRoutes,
  platformRecoveryRoutes,
  platformAuditRoutes,
  platformMeteringRoutes,
  platformRuntimeRoutes,
]);

export const PLATFORM_PRODUCTION_ROUTE_MODULES = Object.freeze([
  platformAuthenticationRoutes,
  ...PLATFORM_OPERATIONAL_ROUTE_MODULES,
]);

const PLATFORM_ROUTE_REGISTRY = createPlatformRouteRegistry(PLATFORM_PRODUCTION_ROUTE_MODULES);

function safeObserverCall(callback) {
  try {
    callback();
  } catch {
    // Observability failure cannot replace the request's authoritative security or HTTP outcome.
  }
}

export function createPlatformApp({
  config,
  platformAuthService,
  platformAuditService,
  platformDiagnosticOperationsService,
  platformEntitlementOperationsService,
  platformFleetReadinessService,
  platformHealthMonitor,
  platformMeteringService,
  platformMicrosoftFleetHealthService,
  platformRecoveryOperationsService,
  platformRuntimeStatusService,
  platformSessionService,
  platformTenantOperationsService,
  routeModules = PLATFORM_PRODUCTION_ROUTE_MODULES,
  readTransactionCookie,
  clientKey = (request) => request.socket.remoteAddress || 'unknown',
  logger = createPlatformLogger(),
  metrics = NOOP_PLATFORM_METRICS,
  clock = () => Date.now(),
  requestIdFactory = createPlatformRequestId,
} = {}) {
  assertPlatformHttpConfig(config);
  if (typeof clientKey !== 'function') throw new TypeError('PLATFORM_CLIENT_KEY_REQUIRED');
  if (!logger || typeof logger.requestCompleted !== 'function') {
    throw new TypeError('PLATFORM_LOGGER_REQUIRED');
  }
  if (!metrics || typeof metrics.recordApiRequest !== 'function') {
    throw new TypeError('PLATFORM_METRICS_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_CLOCK_REQUIRED');
  if (typeof requestIdFactory !== 'function') throw new TypeError('PLATFORM_REQUEST_ID_FACTORY_REQUIRED');

  const routeRegistry = routeModules === PLATFORM_PRODUCTION_ROUTE_MODULES
    ? PLATFORM_ROUTE_REGISTRY
    : createPlatformRouteRegistry(routeModules);

  const platformPrincipalGuard = createPlatformPrincipalGuard({
    platformSessionService,
    platformAuditService,
  });
  const rateLimiter = createPlatformRateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
    maxKeys: config.rateLimitMaxKeys,
    clock,
  });
  const dispatch = routeRegistry.createDispatcher({
    platformAuthService,
    platformAuditService,
    platformDiagnosticOperationsService,
    platformEntitlementOperationsService,
    platformFleetReadinessService,
    platformHealthMonitor,
    platformMeteringService,
    platformMicrosoftFleetHealthService,
    platformRecoveryOperationsService,
    platformRuntimeStatusService,
    platformSessionService,
    platformTenantOperationsService,
    platformPrincipalGuard,
    platformEntraAuthority: config.entraAuthority,
    platformEntraClientId: config.entraClientId,
    platformEntraRedirectUri: config.entraRedirectUri,
    platformAuthenticationContexts: [
      config.mfaAuthenticationContext,
      config.stepUpAuthenticationContext,
    ],
    platformAuthenticationMaxAgeSeconds: config.authenticationMaxAgeSeconds,
    platformPublicOrigin: config.publicOrigin,
    platformRuntimeMetadata: Object.freeze({
      serviceVersion: config.serviceVersion,
      buildId: config.buildId,
      environment: config.mode,
    }),
    readTransactionCookie,
    maxBodyBytes: config.maxBodyBytes,
    maxResponseBytes: config.maxResponseBytes,
  });

  return async function handlePlatformRequest(request, response) {
    const startedAt = clock();
    const requestId = requestIdFactory();
    if (!isInternalUuid(requestId)) throw new TypeError('PLATFORM_REQUEST_ID_INVALID');
    response.setHeader('X-Request-ID', requestId);
    applyPlatformSecurityHeaders(response, config);

    let route = PLATFORM_HTTP_ROUTE.INVALID_REQUEST;
    let statusCode = 500;
    try {
      assertPlatformMethod(request.method);
      assertPlatformRequestTarget(request.url);
      assertPlatformRequestHost(request.headers, config.publicOrigin);
      const parsedUrl = new URL(request.url, config.publicOrigin);
      if (parsedUrl.pathname !== '/api/v1/platform/health/live') {
        rateLimiter.consume(clientKey(request));
      }
      try {
        assertPlatformRequestOrigin(request.headers, config.publicOrigin, {
          required: isPlatformUnsafeMethod(request.method),
        });
      } catch (error) {
        if (error instanceof PlatformHttpError && error.code === 'PLATFORM_ORIGIN_NOT_ALLOWED') {
          await platformPrincipalGuard.recordOriginDenial(request, { correlationId: requestId });
        }
        throw error;
      }

      const context = Object.freeze({
        method: request.method,
        path: parsedUrl.pathname,
        parsedUrl,
        request,
        response,
        requestId,
      });
      route = routeRegistry.routeKey(context) || PLATFORM_HTTP_ROUTE.NOT_FOUND;
      const dispatchedStatus = await dispatch(context);
      if (dispatchedStatus === null) throw new PlatformHttpError(404, 'PLATFORM_NOT_FOUND');
      statusCode = dispatchedStatus;
    } catch (error) {
      const platformError = asPlatformHttpError(error);
      statusCode = platformError.statusCode;
      if (platformError.securityCategory && typeof logger.securityOutcome === 'function') {
        safeObserverCall(() => logger.securityOutcome({
          requestId,
          category: platformError.securityCategory,
        }));
      }
      if (statusCode === 500 && typeof logger.unhandledError === 'function') {
        safeObserverCall(() => logger.unhandledError({ requestId }));
      }
      if (!response.headersSent) {
        sendPlatformJson(response, statusCode, {
          error: Object.freeze({ code: platformError.code, requestId }),
        }, config.maxResponseBytes);
      } else {
        response.destroy();
      }
    } finally {
      recordPlatformRequestCompletionSafely({
        metrics,
        logger,
        requestId,
        method: request.method,
        route,
        statusCode,
        durationMs: Math.max(0, clock() - startedAt),
      });
    }
  };
}

export { PLATFORM_ROUTE_REGISTRY };
