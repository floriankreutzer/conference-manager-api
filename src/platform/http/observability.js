export const PLATFORM_HTTP_ROUTE = Object.freeze({
  AUTH_LOGIN: 'platform_auth_login',
  AUTH_STEP_UP: 'platform_auth_step_up',
  AUTH_CALLBACK: 'platform_auth_callback',
  HEALTH_LIVE: 'platform_health_live',
  HEALTH_READY: 'platform_health_ready',
  HEALTH_STATUS: 'platform_health_status',
  SESSION: 'platform_session',
  TENANT_DIRECTORY: 'platform_tenant_directory',
  TENANT_CREATE: 'platform_tenant_create',
  INVITATION_REVOKE: 'platform_invitation_revoke',
  INVITATION_REISSUE: 'platform_invitation_reissue',
  LIFECYCLE_TRANSITION: 'platform_lifecycle_transition',
  READINESS: 'platform_readiness',
  MICROSOFT_HEALTH: 'platform_microsoft_health',
  CAPABILITIES: 'platform_capabilities',
  PACKAGES: 'platform_packages',
  TENANT_ENTITLEMENTS: 'platform_tenant_entitlements',
  ENTITLEMENT_PREVIEW: 'platform_entitlement_preview',
  PACKAGE_PREVIEW: 'platform_package_preview',
  ENTITLEMENT_APPLY: 'platform_entitlement_apply',
  PACKAGE_APPLY: 'platform_package_apply',
  DIAGNOSTIC_SUMMARY: 'platform_diagnostic_summary',
  DIAGNOSTIC_CORRELATION: 'platform_diagnostic_correlation',
  RECOVERY_LAST_ADMIN_PREVIEW: 'platform_recovery_last_admin_preview',
  RECOVERY_LAST_ADMIN_EXECUTE: 'platform_recovery_last_admin_execute',
  RECOVERY_MICROSOFT_PREVIEW: 'platform_recovery_microsoft_preview',
  RECOVERY_MICROSOFT_EXECUTE: 'platform_recovery_microsoft_execute',
  RECOVERY_MAPPING_PREVIEW: 'platform_recovery_mapping_preview',
  RECOVERY_MAPPING_EXECUTE: 'platform_recovery_mapping_execute',
  RECOVERY_IDENTITY_PREVIEW: 'platform_recovery_identity_preview',
  RECOVERY_IDENTITY_EXECUTE: 'platform_recovery_identity_execute',
  RECOVERY_TENANT_SESSIONS_PREVIEW: 'platform_recovery_tenant_sessions_preview',
  RECOVERY_TENANT_SESSIONS_EXECUTE: 'platform_recovery_tenant_sessions_execute',
  RECOVERY_USER_SESSIONS_PREVIEW: 'platform_recovery_user_sessions_preview',
  RECOVERY_USER_SESSIONS_EXECUTE: 'platform_recovery_user_sessions_execute',
  RECOVERY_SUSPEND_PREVIEW: 'platform_recovery_suspend_preview',
  RECOVERY_SUSPEND_EXECUTE: 'platform_recovery_suspend_execute',
  RECOVERY_REACTIVATE_PREVIEW: 'platform_recovery_reactivate_preview',
  RECOVERY_REACTIVATE_EXECUTE: 'platform_recovery_reactivate_execute',
  RECOVERY_TARGETS: 'platform_recovery_targets',
  AUDIT_EVENTS: 'platform_audit_events',
  AUDIT_EXPORTS: 'platform_audit_exports',
  METERING_USAGE: 'platform_metering_usage',
  QUOTA_SET: 'platform_quota_set',
  RUNTIME_DEPLOYMENTS: 'platform_runtime_deployments',
  TENANT_RUNTIME: 'platform_tenant_runtime',
  NOT_FOUND: 'platform_not_found',
  INVALID_REQUEST: 'platform_invalid_request',
});

const ROUTES = new Set(Object.values(PLATFORM_HTTP_ROUTE));
const METHODS = new Set(['GET', 'POST', 'DELETE', 'OTHER']);
const SECURITY_CATEGORIES = new Set(['authentication', 'authorization']);

export function assertPlatformRouteKey(value) {
  if (!ROUTES.has(value)) throw new TypeError('PLATFORM_ROUTE_KEY_INVALID');
  return value;
}

export function createPlatformLogger({ write = (line) => process.stdout.write(line) } = {}) {
  if (typeof write !== 'function') throw new TypeError('PLATFORM_LOG_WRITER_REQUIRED');

  function emit(entry) {
    write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  }

  return Object.freeze({
    requestCompleted({ requestId, method, route, statusCode, durationMs }) {
      emit({
        level: 'info',
        event: 'platform_request_completed',
        requestId,
        method: METHODS.has(method) ? method : 'OTHER',
        route: assertPlatformRouteKey(route),
        statusCode,
        durationMs,
      });
    },
    securityOutcome({ requestId, category }) {
      if (!SECURITY_CATEGORIES.has(category)) {
        throw new TypeError('PLATFORM_LOG_SECURITY_CATEGORY_INVALID');
      }
      emit({
        level: 'warn',
        event: 'platform_security_request_denied',
        requestId,
        category,
      });
    },
    unhandledError({ requestId }) {
      emit({ level: 'error', event: 'platform_unhandled_error', requestId });
    },
  });
}

export const NOOP_PLATFORM_METRICS = Object.freeze({
  recordApiRequest() {},
});

export function recordPlatformRequestCompletionSafely({
  metrics,
  logger,
  requestId,
  method,
  route,
  statusCode,
  durationMs,
}) {
  const safeMethod = METHODS.has(method) ? method : 'OTHER';
  const safeRoute = assertPlatformRouteKey(route);
  try {
    metrics.recordApiRequest({
      route: safeRoute,
      method: safeMethod,
      statusCode,
      durationMs,
    });
  } catch {
    // Operational telemetry is non-authoritative and cannot replace a determined HTTP outcome.
  }
  try {
    logger.requestCompleted({
      requestId,
      method: safeMethod,
      route: safeRoute,
      statusCode,
      durationMs,
    });
  } catch {
    // Keep independent observers isolated from request handling and from one another.
  }
}
