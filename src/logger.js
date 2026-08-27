const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const ROUTES = new Set([
  'health_live',
  'health_ready',
  'health_status',
  'entra_login',
  'entra_callback',
  'onboarding_start',
  'onboarding_claim',
  'session',
  'audit',
  'tenant_users',
  'tenant_user_roles',
  'application_profile',
  'application_catalog',
  'application_site_info',
  'application_requests',
  'application_request_report',
  'application_request_resubmission',
  'application_room_availability',
  'application_notifications',
  'application_notification',
  'application_configuration',
  'tenant_settings_locations',
  'tenant_settings_locations_history',
  'tenant_settings_locations_revision',
  'tenant_settings_locations_rollback',
  'tenant_settings_organization',
  'tenant_settings_organization_history',
  'tenant_presentation',
  'tenant_settings_catalogue',
  'tenant_settings_catalogue_history',
  'tenant_settings_booking_policies',
  'tenant_settings_booking_policies_history',
  'tenant_settings_booking_policies_revision',
  'tenant_settings_cost_allocation',
  'tenant_settings_cost_allocation_history',
  'tenant_settings_cost_allocation_revision',
  'tenant_user_lifecycle_list',
  'tenant_user_lifecycle_access',
  'tenant_audit_query',
  'tenant_capabilities',
  'microsoft365_connection',
  'microsoft365_connect',
  'microsoft365_callback',
  'microsoft365_verify',
  'microsoft365_free_busy_verify',
  'microsoft365_pilot_readiness',
  'microsoft365_rooms',
  'microsoft365_room_mappings',
  'microsoft365_room_import',
  'microsoft365_room_sync',
  'request',
  'request_transition',
  'booking_change',
  'booking_change_decision',
  'request_history',
  'not_found',
  'invalid_request',
]);
const HEALTH_STATES = new Set(['ready', 'degraded', 'not_ready']);
const SECURITY_CATEGORIES = new Set(['authentication', 'authorization']);

function assertEnum(value, allowed, code) {
  if (!allowed.has(value)) throw new TypeError(code);
  return value;
}

export function createLogger({ write = (line) => process.stdout.write(line), level = 'info' } = {}) {
  if (!LEVELS.has(level)) throw new TypeError('INVALID_LOG_LEVEL');

  function emit(entry) {
    const safeEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    write(`${JSON.stringify(safeEntry)}\n`);
  }

  return Object.freeze({
    requestCompleted({ requestId, method, route, statusCode, durationMs }) {
      emit({
        level: 'info',
        event: 'request_completed',
        requestId,
        method,
        route: assertEnum(route, ROUTES, 'LOG_ROUTE_INVALID'),
        statusCode,
        durationMs,
      });
    },
    unhandledError({ requestId, errorName }) {
      emit({ level: 'error', event: 'unhandled_error', requestId, errorName });
    },
    securityOutcome({ requestId, category }) {
      emit({
        level: 'warn',
        event: 'security_request_denied',
        requestId,
        category: assertEnum(category, SECURITY_CATEGORIES, 'LOG_SECURITY_CATEGORY_INVALID'),
      });
    },
    healthEvaluated({ requestId, status }) {
      emit({
        level: status === 'not_ready' ? 'error' : status === 'degraded' ? 'warn' : 'info',
        event: 'health_evaluated',
        requestId,
        status: assertEnum(status, HEALTH_STATES, 'LOG_HEALTH_STATUS_INVALID'),
      });
    },
    lifecycle({ event, serviceVersion, buildId, environment }) {
      emit({
        level: 'info',
        event,
        ...(serviceVersion ? { serviceVersion } : {}),
        ...(buildId ? { buildId } : {}),
        ...(environment ? { environment } : {}),
      });
    },
  });
}
