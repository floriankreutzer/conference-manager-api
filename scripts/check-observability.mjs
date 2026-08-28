import { readFile } from 'node:fs/promises';
import { TELEMETRY_ROUTE_KEYS } from '../src/observability/route-vocabulary.js';

const routeKeySet = new Set(TELEMETRY_ROUTE_KEYS);
if (!Object.isFrozen(TELEMETRY_ROUTE_KEYS) || routeKeySet.size !== TELEMETRY_ROUTE_KEYS.length) {
  throw new Error('Operational route vocabulary must be frozen and contain unique identities.');
}
for (const route of TELEMETRY_ROUTE_KEYS) {
  if (typeof route !== 'string' || !/^[a-z][a-z0-9_]{0,95}$/.test(route)) {
    throw new Error(`Operational route identity is not fixed and bounded: ${String(route)}.`);
  }
}
for (const aggregate of ['locations', 'catalogue', 'cost_allocation']) {
  for (const operation of ['template', 'export', 'validate', 'apply']) {
    const route = `tenant_settings_${aggregate}_bulk_${operation}`;
    if (!routeKeySet.has(route)) throw new Error(`Operational route vocabulary is missing ${route}.`);
  }
}

const metrics = await readFile('src/observability/metrics.js', 'utf8');
for (const forbidden of ['tenantId', 'userId', 'requestId', 'providerReference', 'email', 'cookie', 'token']) {
  if (metrics.includes(forbidden)) {
    throw new Error(`Metrics registry must not use high-cardinality or sensitive dimension ${forbidden}.`);
  }
}
for (const required of [
  'api_requests_total',
  'authentication_failures_total',
  'authorization_denials_total',
  'booking_operations_total',
  'integration_calls_total',
  'dependency_health_observations_total',
]) {
  if (!metrics.includes(required)) throw new Error(`Metrics registry is missing ${required}.`);
}
if (!metrics.includes("assertTelemetryRouteKey(route, 'METRIC_ROUTE_INVALID')")) {
  throw new Error('Metrics registry must consume the shared bounded route vocabulary.');
}

const health = await readFile('src/observability/health.js', 'utf8');
for (const required of ['readinessChecks', 'degradationChecks', "status: ready ? (degraded ? 'degraded' : 'ready')"]) {
  if (!health.includes(required)) throw new Error(`Health monitor is missing ${required}.`);
}

const app = await readFile('src/app.js', 'utf8');
for (const required of [
  "status: '/api/v1/health/status'",
  'createHealthMonitor',
  'recordAuthenticationFailure',
  'recordAuthorizationDenied',
  'recordApiRequest',
  'tenantUserLifecycleRouteModule',
  'tenantAuditQueryRouteModule',
  "return 'tenant_user_roles'",
  "return 'request_transition'",
  "return 'booking_change'",
  "return 'booking_change_decision'",
  "return 'request'",
  'recordRequestCompletionSafely',
]) {
  if (!app.includes(required)) throw new Error(`HTTP observability composition is missing ${required}.`);
}
if (app.includes('logger.requestCompleted({\n        requestId,\n        method: request.method,\n        path')) {
  throw new Error('Operational request logging must use a fixed route key instead of a dynamic path.');
}

const logger = await readFile('src/logger.js', 'utf8');
for (const forbidden of ['cookie', 'csrf', 'providerReference', 'tenantId', 'userId']) {
  if (logger.includes(forbidden)) {
    throw new Error(`Operational logger must not accept sensitive or tenant/object identifier ${forbidden}.`);
  }
}
if (!logger.includes("assertTelemetryRouteKey(route, 'LOG_ROUTE_INVALID')")) {
  throw new Error('Operational request logging must consume the shared bounded route vocabulary.');
}

const booking = await readFile('src/application/booking-integration-service.js', 'utf8');
for (const required of ['recordBookingOperation', 'recordIntegrationCall']) {
  if (!booking.includes(required)) throw new Error(`Booking observability is missing ${required}.`);
}

const config = await readFile('src/config.js', 'utf8');
for (const required of ['SERVICE_VERSION_REQUIRED', 'BUILD_ID_REQUIRED', 'SUPPORT_IDENTIFIER']) {
  if (!config.includes(required)) throw new Error(`Support metadata configuration is missing ${required}.`);
}

console.log('Production observability boundary check passed.');
