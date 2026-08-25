import { readFile } from 'node:fs/promises';

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!pool.includes('CURRENT_SCHEMA_VERSION = 14 + 1')) {
  throw new Error('Production application contract requires schema migration version 15.');
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
  'authorizationPolicy.authorizeApplicationRead',
  'authorizationPolicy.authorizeRequestCreate',
  'authorizationPolicy.authorizeRequestList',
  'AUDIT_ACTION.REQUEST_CREATED',
]) {
  if (!service.includes(required)) throw new Error(`Production application service is missing ${required}.`);
}

const routes = await readFile('src/http/application-routes.js', 'utf8');
for (const required of [
  "'/api/v1/application/profile'",
  "'/api/v1/application/catalog'",
  "'/api/v1/application/site-info'",
  "'/api/v1/application/requests'",
  "'/api/v1/application/notifications'",
  "'/api/v1/application/configuration'",
  'sessionService.verifyCsrf',
]) {
  if (!routes.includes(required)) throw new Error(`Production application HTTP contract is missing ${required}.`);
}

const repository = await readFile('src/persistence/postgres/application-repository.js', 'utf8');
for (const required of [
  'tenant_id = $1',
  'loadCatalog',
  'loadSiteInfo',
  'listNotifications',
  'updateNotification',
]) {
  if (!repository.includes(required)) throw new Error(`Production application persistence is missing ${required}.`);
}

console.log('Production application contract check passed.');
