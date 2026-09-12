import { access, readFile } from 'node:fs/promises';

async function mustExist(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Tenant settings foundation is missing ${path}.`);
  }
}

for (const path of [
  'src/application/tenant-settings-revision.js',
  'src/application/tenant-settings-errors.js',
  'migrations/020_tenant_settings_revisions.up.sql',
  'migrations/020_tenant_settings_revisions.down.sql',
  'docs/TENANT-SETTINGS-CONTRACTS.md',
  'src/domain/tenant-locations.js',
  'src/application/tenant-location-administration-service.js',
  'src/persistence/postgres/tenant-location-repository.js',
  'src/http/settings/locations.js',
  'src/observability/route-vocabulary.js',
  'migrations/021_tenant_location_self_service.up.sql',
  'migrations/021_tenant_location_self_service.down.sql',
]) await mustExist(path);

for (const forbidden of [
  'src/application/tenant-settings-service.js',
  'src/persistence/postgres/tenant-settings-repository.js',
  'src/http/tenant-settings-routes.js',
]) {
  try {
    await access(forbidden);
    throw new Error(`${forbidden} would create a forbidden generic Tenant settings owner.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const revision = await readFile('src/application/tenant-settings-revision.js', 'utf8');
for (const required of [
  'TENANT_SETTINGS_SCHEMA_VERSION = 1',
  'TENANT_SETTINGS_INITIAL_REVISION = 1',
  'assertTenantSettingsRevision',
  'nextTenantSettingsRevision',
]) {
  if (!revision.includes(required)) throw new Error(`Tenant settings revision primitive is missing ${required}.`);
}
if (/repository|SELECT|UPDATE|INSERT INTO|DELETE FROM/i.test(revision)) {
  throw new Error('Shared Tenant settings revision primitive must not own persistence.');
}

const pool = await readFile('src/persistence/postgres/pool.js', 'utf8');
if (!/export const CURRENT_SCHEMA_VERSION = 35;/.test(pool)) {
  throw new Error('Runtime schema readiness must require the Request composition v3 migration version 35.');
}

const migration = await readFile('migrations/020_tenant_settings_revisions.up.sql', 'utf8');
for (const column of [
  'organization_revision',
  'locations_revision',
  'catalog_revision',
  'booking_policies_revision',
  'cost_allocation_revision',
]) {
  if (!migration.includes(column)) throw new Error(`Migration 020 is missing independent ${column}.`);
}
if (/settings\s+json|settings_document|tenant_settings\s*\(/i.test(migration)) {
  throw new Error('Migration 020 must not introduce a generic settings document/table.');
}
const rollback = await readFile('migrations/020_tenant_settings_revisions.down.sql', 'utf8');
if (!rollback.includes('LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE')) {
  throw new Error('Tenant settings rollback must serialize the populated-revision guard.');
}
if (!rollback.includes('TENANT_SETTINGS_REVISIONS_REQUIRE_REVIEW')) {
  throw new Error('Tenant settings rollback must fail closed after any aggregate revision advances.');
}

const locationMigration = await readFile('migrations/021_tenant_location_self_service.up.sql', 'utf8');
for (const required of [
  'tenant_location_revisions',
  'sites_details_object',
  'rooms_details_object',
]) {
  if (!locationMigration.includes(required)) throw new Error(`Location migration is missing ${required}.`);
}
if (/\b(?:BEGIN|COMMIT)\s*;|\bschema_migrations\b/i.test(locationMigration)) {
  throw new Error('Location migration must use runner-owned transactions and schema bookkeeping.');
}
if (/UPDATE\s+sites[\s\S]{0,200}time_zone\s*=\s*['\"]?UTC/i.test(locationMigration)) {
  throw new Error('Location migration must never fabricate UTC or another Site time zone for legacy data.');
}
const locationRollback = await readFile('migrations/021_tenant_location_self_service.down.sql', 'utf8');
for (const required of [
  'LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE',
  'LOCK TABLE tenant_location_revisions IN ACCESS EXCLUSIVE MODE',
  "FROM sites WHERE details <> '{}'::jsonb",
  "FROM rooms WHERE details <> '{}'::jsonb",
  'TENANT_LOCATION_HISTORY_REQUIRE_REVIEW',
]) {
  if (!locationRollback.includes(required)) throw new Error(`Location rollback is missing ${required}.`);
}
if (/\b(?:BEGIN|COMMIT)\s*;|\bschema_migrations\b/i.test(locationRollback)) {
  throw new Error('Location rollback must use runner-owned transactions and schema bookkeeping.');
}
const locationRepository = await readFile('src/persistence/postgres/tenant-location-repository.js', 'utf8');
for (const required of [
  'locations_revision',
  'tenant_location_revisions',
  'booking_provider_references',
  'booking_change_requests',
  'microsoft365_room_mappings',
]) {
  if (!locationRepository.includes(required)) throw new Error(`Location repository is missing ${required}.`);
}
if (/external_room_id\s*[:=]|resource_address\s*[:=]/.test(await readFile('src/domain/tenant-locations.js', 'utf8'))) {
  throw new Error('Mutable Tenant location domain must not accept Microsoft provider identifiers.');
}

const applicationRoutes = await readFile('src/http/application-routes.js', 'utf8');
if (applicationRoutes.includes("'/api/v1/tenant/settings'")) {
  throw new Error('A generic Tenant settings route is forbidden; each aggregate owns a bounded route module.');
}
if (applicationRoutes.includes("from './settings/locations.js'") || applicationRoutes.includes('CONFIGURATION_BODY_SCHEMA')) {
  throw new Error('Legacy application routes must not own or mutate the bounded Locations aggregate.');
}
if (!/APPLICATION_ROUTES\.configuration[\s\S]{0,200}request\.method !== 'GET'/.test(applicationRoutes)) {
  throw new Error('Legacy application configuration writes must remain disabled after Locations rollout.');
}

const locationRoutes = await readFile('src/http/settings/locations.js', 'utf8');
for (const required of ['defineRouteModule', "id: 'tenant-locations'", 'tenantLocationAdministrationService']) {
  if (!locationRoutes.includes(required)) throw new Error(`Location route module is missing ${required}.`);
}
const app = await readFile('src/app.js', 'utf8');
for (const required of [
  'createRouteModuleRegistry',
  'tenantPresentationRouteModule',
  'tenantOrganizationRouteModule',
  'tenantLocationRoutes',
  'tenantCatalogueRouteModule',
  'tenantBookingPolicyRoutes',
  'tenantCostAllocationRoutes',
  'tenantRouteHandler',
]) {
  if (!app.includes(required)) throw new Error(`Application route registration is missing ${required}.`);
}
const routeVocabulary = await readFile('src/observability/route-vocabulary.js', 'utf8');
for (const routeKey of [
  'tenant_settings_locations',
  'tenant_settings_locations_history',
  'tenant_settings_locations_revision',
  'tenant_settings_locations_rollback',
  'tenant_settings_locations_bulk_template',
  'tenant_settings_locations_bulk_export',
  'tenant_settings_locations_bulk_validate',
  'tenant_settings_locations_bulk_apply',
  'tenant_settings_organization',
  'tenant_settings_organization_history',
  'tenant_presentation',
  'tenant_settings_catalogue',
  'tenant_settings_catalogue_history',
  'tenant_settings_catalogue_bulk_template',
  'tenant_settings_catalogue_bulk_export',
  'tenant_settings_catalogue_bulk_validate',
  'tenant_settings_catalogue_bulk_apply',
  'tenant_settings_booking_policies',
  'tenant_settings_booking_policies_history',
  'tenant_settings_booking_policies_revision',
  'tenant_settings_cost_allocation',
  'tenant_settings_cost_allocation_history',
  'tenant_settings_cost_allocation_revision',
  'tenant_settings_cost_allocation_bulk_template',
  'tenant_settings_cost_allocation_bulk_export',
  'tenant_settings_cost_allocation_bulk_validate',
  'tenant_settings_cost_allocation_bulk_apply',
]) {
  if (!routeVocabulary.includes(`'${routeKey}'`)) {
    throw new Error(`Shared observability vocabulary is missing safe route key ${routeKey}.`);
  }
}

const contracts = await readFile('docs/TENANT-SETTINGS-CONTRACTS.md', 'utf8');
for (const owner of [
  'Organization',
  'Locations and rooms',
  'Service and catering catalogue',
  'Booking policies',
  'Cost allocation',
]) {
  if (!contracts.includes(owner)) throw new Error(`Tenant settings ownership contract is missing ${owner}.`);
}
for (const required of [
  'TENANT_SETTINGS_REVISION_CONFLICT',
  'currentRevision',
  'schemaVersion',
  'expectedRevision',
  'Demo',
  'audit',
]) {
  if (!contracts.includes(required)) throw new Error(`Tenant settings contract is missing ${required}.`);
}
