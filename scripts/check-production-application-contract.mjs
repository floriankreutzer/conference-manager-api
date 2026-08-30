import { readFile } from 'node:fs/promises';

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!/export const CURRENT_SCHEMA_VERSION = 33;/.test(pool)) {
  throw new Error('Production application contract requires the integrated SaaS 3 schema version 33.');
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
  'requestRepository.findByTenantIdAndId',
  'calendarProviderFactory.forRoom',
  'normalizeAvailabilityResult',
  'authorizationPolicy.authorizeRequestRead',
  'request.requesterUserId !== principal.userId',
  "request.status !== 'Change Requested'",
  'excludeRequestId,',
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
  'application_request_report',
  'application_request_resubmission',
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
  "requestReport: '/api/v1/application/reports/requests'",
  "roomAvailability: '/api/v1/application/room-availability'",
  "notifications: '/api/v1/application/notifications'",
  "configuration: '/api/v1/application/configuration'",
  "principalGuard.require(request, { csrf: mutation })",
  'tenantGuard.requireActive(principal)',
  'validateExactObject',
  'REQUEST_RESUBMISSION_PATH',
  'requestReportQuery',
  'schemaVersion: (value) => value === 2',
]) {
  if (!routes.includes(required)) throw new Error(`Production application HTTP contract is missing ${required}.`);
}

const routeVocabulary = await readFile('src/observability/route-vocabulary.js', 'utf8');
for (const routeKey of applicationRouteKeys) {
  if (!routeVocabulary.includes(`'${routeKey}'`)) {
    throw new Error(`Shared observability vocabulary is missing production application route ${routeKey}.`);
  }
}

const apiContract = await readFile('docs/API.md', 'utf8');
for (const required of [
  'POST /api/v1/application/room-availability',
  '`ROOM_AVAILABILITY_UNAVAILABLE`',
  'canonical UTC interval of at most 24 hours',
  '`bookingPolicy`',
  '`costAllocation`',
  'currently active `costCenters[]`',
  'GET /api/v1/application/reports/requests',
  '`complete`',
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
  "isolationLevel: 'REPEATABLE READ'",
  'tenant_room_prices',
  'configurationRevisions',
  'tenant_cost_allocation_configuration',
  'tenant_cost_centers',
  'tenant_booking_policy_configuration',
  'transaction_timestamp()',
  'bookingPolicy',
  'allocationRequired',
  'costCenters',
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
for (const required of [
  'authorizeRequestReport',
  'normalizeRequestReportQuery',
  'createRequestReportCursor',
  'listReportPageByTenantId',
]) {
  if (!applicationService.includes(required)) {
    throw new Error(`Production Request reporting is missing ${required}.`);
  }
}
const authorizationPolicy = await readFile('src/authorization/policy.js', 'utf8');
for (const required of ['authorizeRequestReport', 'PERMISSION.REQUEST_MANAGE']) {
  if (!authorizationPolicy.includes(required)) {
    throw new Error(`Production Request reporting authorization is missing ${required}.`);
  }
}
const requestRepository = await readFile('src/persistence/postgres/request-repository.js', 'utf8');
for (const required of [
  'request-report-page-by-tenant',
  'starts_at >= $2',
  'starts_at < $3',
  'ORDER BY starts_at, id',
]) {
  if (!requestRepository.includes(required)) {
    throw new Error(`Production Request report persistence is missing ${required}.`);
  }
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

const entrypoint = await readFile('src/index.js', 'utf8');
for (const required of [
  "import { createCustomerComposition } from './customer-composition.js'",
  'const composition = createCustomerComposition({',
  'await composition.start()',
]) {
  if (!entrypoint.includes(required)) {
    throw new Error(`Production customer entrypoint is missing composition linkage ${required}.`);
  }
}
if (entrypoint.includes('createRoomAvailabilityService')) {
  throw new Error('Production customer entrypoint must remain thin and delegate room availability wiring.');
}

const composition = await readFile('src/customer-composition.js', 'utf8');
for (const required of [
  'createRoomAvailabilityService',
  'repository: persistence.bookingReferenceRepository',
  'requestRepository: persistence.requestRepository',
  'calendarProviderFactory: microsoft365CalendarProviderFactory',
  'roomAvailabilityService,',
]) {
  if (!composition.includes(required)) {
    throw new Error(`Production room-availability composition is missing ${required}.`);
  }
}

await readFile('tests/room-availability-composition.test.js', 'utf8');
await readFile('tests/request-composition.test.js', 'utf8');

console.log('Production application contract check passed.');
