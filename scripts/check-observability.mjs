import { readFile } from 'node:fs/promises';

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
  "return 'tenant_users'",
  "return 'tenant_user_roles'",
  "return 'request_transition'",
  "return 'request'",
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
for (const required of [
  "'tenant_users'",
  "'tenant_user_roles'",
  'route: assertEnum(route, ROUTES',
]) {
  if (!logger.includes(required)) throw new Error(`Operational request logging is missing bounded route contract ${required}.`);
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
