import { readFile } from 'node:fs/promises';

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!pool.includes('CURRENT_SCHEMA_VERSION = 14 + 2')) {
  throw new Error('Production application contract requires request-created migration 15 and current schema 16.');
}

const auditEvent = await readFile('src/audit/event.js', 'utf8');
if (!auditEvent.includes("REQUEST_CREATED: 'request.created'")) {
  throw new Error('Production request creation must use the fixed request.created audit action.');
}

const up = await readFile('migrations/015_request_created_audit_action.up.sql', 'utf8');
for (const required of [
  'ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid',
  "'request.created'",
]) {
  if (!up.includes(required)) throw new Error(`Request-created audit migration is missing ${required}.`);
}

const down = await readFile('migrations/015_request_created_audit_action.down.sql', 'utf8');
for (const required of [
  "WHERE action = 'request.created'",
  'REQUEST_CREATED_AUDIT_ROWS_REQUIRE_REVIEW',
]) {
  if (!down.includes(required)) throw new Error(`Request-created audit rollback is missing ${required}.`);
}

const service = await readFile('src/application/production-application-service.js', 'utf8');
for (const required of [
  'authorizationPolicy.authorizeTenantApplicationRead',
  'authorizationPolicy.authorizeRequestCreate',
  'authorizationPolicy.requestListScope',
  'authorizationPolicy.requireTenantPermission',
  'AUDIT_ACTION.REQUEST_CREATED',
]) {
  if (!service.includes(required)) throw new Error(`Production application service is missing ${required}.`);
}

const routes = await readFile('src/http/application-routes.js', 'utf8');
for (const required of [
  "profile: '/api/v1/application/profile'",
  "catalog: '/api/v1/application/catalog'",
  "siteInfo: '/api/v1/application/site-info'",
  "requests: '/api/v1/application/requests'",
  "notifications: '/api/v1/application/notifications'",
  "configuration: '/api/v1/application/configuration'",
  "principalGuard.require(request, { csrf: mutation })",
  'tenantGuard.requireActive(principal)',
  'validateExactObject',
]) {
  if (!routes.includes(required)) throw new Error(`Production application HTTP contract is missing ${required}.`);
}

const repository = await readFile('src/persistence/postgres/application-repository.js', 'utf8');
for (const required of [
  'tenant_id = $1',
  'loadCatalog',
  'listNotifications',
  'markNotificationRead',
  'updateSites',
  'auditRepository.appendWithClient(client, auditEvent)',
]) {
  if (!repository.includes(required)) throw new Error(`Production application persistence is missing ${required}.`);
}

console.log('Production application contract check passed.');
