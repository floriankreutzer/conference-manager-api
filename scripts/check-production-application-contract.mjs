import { readFile } from 'node:fs/promises';

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!/export const CURRENT_SCHEMA_VERSION = 21;/.test(pool)) {
  throw new Error('Production application contract requires bounded Tenant locations and current schema 21.');
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
  'roomAvailabilityService.checkAvailability',
  'isIanaTimeZone',
  'SiteTimeZoneRequiredError',
]) {
  if (!service.includes(required)) throw new Error(`Production application service is missing ${required}.`);
}

const availabilityService = await readFile('src/application/room-availability-service.js', 'utf8');
for (const required of [
  'authorizationPolicy.authorizeRequestCreate',
  'CAPABILITY.MICROSOFT_CALENDAR',
  'repository.hasConflictingRequest',
  'calendarProviderFactory.forRoom',
  'normalizeAvailabilityResult',
  'excludeRequestId: null',
  'RoomAvailabilityUnavailableError',
]) {
  if (!availabilityService.includes(required)) {
    throw new Error(`Production room availability service is missing ${required}.`);
  }
}

const routes = await readFile('src/http/application-routes.js', 'utf8');
const applicationRouteKeys = [
  'application_profile',
  'application_catalog',
  'application_site_info',
  'application_requests',
  'application_room_availability',
  'application_notifications',
  'application_notification',
  'application_configuration',
];
for (const required of [
  "profile: '/api/v1/application/profile'",
  "catalog: '/api/v1/application/catalog'",
  "siteInfo: '/api/v1/application/site-info'",
  "requests: '/api/v1/application/requests'",
  "roomAvailability: '/api/v1/application/room-availability'",
  "notifications: '/api/v1/application/notifications'",
  "configuration: '/api/v1/application/configuration'",
  "principalGuard.require(request, { csrf: mutation })",
  'tenantGuard.requireActive(principal)',
  'validateExactObject',
]) {
  if (!routes.includes(required)) throw new Error(`Production application HTTP contract is missing ${required}.`);
}

for (const file of ['src/logger.js', 'src/observability/metrics.js']) {
  const source = await readFile(file, 'utf8');
  for (const routeKey of applicationRouteKeys) {
    if (!source.includes(`'${routeKey}'`)) {
      throw new Error(`${file} cannot safely observe production application route ${routeKey}.`);
    }
  }
}

const apiContract = await readFile('docs/API.md', 'utf8');
for (const required of [
  'POST /api/v1/application/room-availability',
  '`ROOM_AVAILABILITY_UNAVAILABLE`',
  'canonical UTC interval of at most 24 hours',
]) {
  if (!apiContract.includes(required)) {
    throw new Error(`Production application API documentation is missing ${required}.`);
  }
}

const repository = await readFile('src/persistence/postgres/application-repository.js', 'utf8');
for (const required of [
  'tenant_id = $1',
  'loadCatalog',
  'listNotifications',
  'markNotificationRead',
  'findRoomBookingContext',
  'time_zone',
  'auditRepository.appendWithClient(client, auditEvent)',
]) {
  if (!repository.includes(required)) throw new Error(`Production application persistence is missing ${required}.`);
}
if (repository.includes('updateSites')) {
  throw new Error('Legacy application persistence must not expose a Site write path.');
}
const applicationService = await readFile('src/application/production-application-service.js', 'utf8');
if (applicationService.includes('updateConfiguration')) {
  throw new Error('Legacy application service must remain read-only for Tenant configuration.');
}

const timeZone = await readFile('src/domain/site-time-zone.js', 'utf8');
for (const required of ['Intl.DateTimeFormat', 'IANA_TIME_ZONE', 'TIME_ZONE_MAX_LENGTH']) {
  if (!timeZone.includes(required)) throw new Error(`Site time-zone validation is missing ${required}.`);
}

const timeZoneMigration = await readFile('migrations/018_site_time_zones.up.sql', 'utf8');
for (const required of ['ADD COLUMN time_zone varchar(64)', 'sites_time_zone_valid']) {
  if (!timeZoneMigration.includes(required)) {
    throw new Error(`Site time-zone migration is missing ${required}.`);
  }
}
const timeZoneRollback = await readFile('migrations/018_site_time_zones.down.sql', 'utf8');
if (!timeZoneRollback.includes('SITE_TIME_ZONE_ROWS_REQUIRE_REVIEW')) {
  throw new Error('Site time-zone rollback must fail closed while configured values exist.');
}

const composition = await readFile('src/index.js', 'utf8');
for (const required of [
  'createRoomAvailabilityService',
  'repository: persistence.bookingReferenceRepository',
  'calendarProviderFactory: microsoft365CalendarProviderFactory',
  'roomAvailabilityService,',
]) {
  if (!composition.includes(required)) {
    throw new Error(`Production room-availability composition is missing ${required}.`);
  }
}

await readFile('tests/room-availability-composition.test.js', 'utf8');

console.log('Production application contract check passed.');
