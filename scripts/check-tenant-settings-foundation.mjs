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
if (!/export const CURRENT_SCHEMA_VERSION = 20;/.test(pool)) {
  throw new Error('Runtime schema readiness must require Tenant settings revision migration version 20.');
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
if (!rollback.includes('Cannot remove tenant settings revisions after versioned configuration writes exist')) {
  throw new Error('Tenant settings rollback must fail closed after any aggregate revision advances.');
}

const applicationRoutes = await readFile('src/http/application-routes.js', 'utf8');
const configurationSchema = applicationRoutes.match(
  /const CONFIGURATION_BODY_SCHEMA[\s\S]*?\n\}\);/,
)?.[0] || '';
if (!configurationSchema.includes('sites:') || /services|catering|polic|cost|organization/i.test(configurationSchema)) {
  throw new Error('Legacy application configuration must remain Site-only during bounded-domain migration.');
}
if (applicationRoutes.includes("'/api/v1/tenant/settings'")) {
  throw new Error('A generic Tenant settings route is forbidden; each aggregate owns a bounded route module.');
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
