import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantCatalogueService } from '../src/application/tenant-catalogue-service.js';
import { createTenantOrganizationService } from '../src/application/tenant-organization-service.js';
import { TenantSettingsConflictError } from '../src/application/tenant-settings-errors.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import {
  createPostgresTenantCatalogueRepository,
} from '../src/persistence/postgres/tenant-catalogue-repository.js';
import {
  createPostgresTenantOrganizationRepository,
} from '../src/persistence/postgres/tenant-organization-repository.js';
import {
  loadMigrations,
  migrateUp,
  rollbackLatest,
  rollbackToVersion,
} from './support/db-migrations.js';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = '61111111-1111-4111-8111-111111111111';
const TENANT_B = '62222222-2222-4222-8222-222222222222';
const ADMIN_A = '63333333-3333-4333-8333-333333333333';
const ADMIN_B = '64444444-4444-4444-8444-444444444444';
const CORRELATION_A = '65555555-5555-4555-8555-555555555555';
const CORRELATION_B = '66666666-6666-4666-8666-666666666666';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';
const AUDIT_KEY = 'organization-catalogue-audit-key-at-least-32-bytes';
const TENANTS = [TENANT_A, TENANT_B];

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function principal(tenantId, userId) {
  return {
    tenantId,
    userId,
    roles: ['employee', 'conference_manager', 'tenant_admin'],
    permissions: [
      'request:read',
      'request:cancel',
      'request:manage',
      'tenant:rooms:business:manage',
      'tenant:catalogue:manage',
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ],
  };
}

function organization(name) {
  return {
    displayName: name,
    businessMetadata: { legalName: name, registrationNumber: null, countryCode: 'DE' },
    presentation: { defaultLocale: 'de-DE', defaultCurrency: 'EUR' },
    branding: { logoAssetRef: null, accentToken: 'default' },
  };
}

function entry(id, name, amountMinor = 1000) {
  return {
    id,
    name,
    description: null,
    price: { amountMinor, currency: 'EUR' },
    active: true,
    order: 1,
    siteIds: [SITE_A],
    roomIds: [ROOM_A],
  };
}

function catalogue(serviceName = 'Video support') {
  return {
    services: [entry('video-support', serviceName, 2500)],
    equipment: [entry('projector', 'Projector', 1000)],
    cateringItems: [entry('coffee', 'Coffee', 300)],
    cateringPackages: [{
      ...entry('meeting', 'Meeting package', 1500),
      itemIds: ['coffee'],
      variants: [{
        id: 'premium',
        name: 'Premium',
        description: null,
        price: { amountMinor: 2200, currency: 'EUR' },
        active: true,
        order: 1,
      }],
    }],
  };
}

async function disableDeleteEnable(pool, table, trigger, tenantIds = TENANTS) {
  await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
  } finally {
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
}

async function cleanDomainData(pool) {
  const relationTables = [
    'catering_item_room_applicability',
    'catering_item_site_applicability',
    'catering_package_room_applicability',
    'catering_package_site_applicability',
    'equipment_room_applicability',
    'equipment_site_applicability',
    'service_room_applicability',
    'service_site_applicability',
    'catering_package_items',
    'catering_package_variants',
  ];
  for (const table of relationTables) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [TENANTS]);
  }
  for (const table of ['equipment', 'services', 'catering_packages', 'catering_items']) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [TENANTS]);
  }
  await disableDeleteEnable(
    pool,
    'tenant_catalogue_revisions',
    'tenant_catalogue_revisions_append_only',
  );
}

async function cleanAll(pool) {
  await removeSaas2TenantAdministrationFixtures(pool, TENANTS);
  await cleanDomainData(pool);
  await disableDeleteEnable(
    pool,
    'tenant_organization_revisions',
    'tenant_organization_revisions_append_only',
  );
  await pool.query('DELETE FROM tenant_organization_settings WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await disableDeleteEnable(pool, 'audit_events', 'audit_events_append_only');
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANTS]);
}

async function seed(pool) {
  await cleanAll(pool);
  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES
       ($1, 'Tenant A', 'active', $3, $3),
       ($2, 'Tenant B', 'active', $3, $3)`,
    [TENANT_A, TENANT_B, '2026-08-27T08:00:00.000Z'],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name)
     VALUES ($1, $2, 'Admin A'), ($3, $4, 'Admin B')`,
    [TENANT_A, ADMIN_A, TENANT_B, ADMIN_B],
  );
  await pool.query(
    `INSERT INTO sites (tenant_id, id, name)
     VALUES ($1, $2, 'Site A'), ($3, $4, 'Site B')`,
    [TENANT_A, SITE_A, TENANT_B, SITE_B],
  );
  await pool.query(
    `INSERT INTO rooms (tenant_id, id, site_id, name, capacity)
     VALUES ($1, $2, $3, 'Room A', 20), ($4, $5, $6, 'Room B', 20)`,
    [TENANT_A, ROOM_A, SITE_A, TENANT_B, ROOM_B, SITE_B],
  );
}

test('organization and catalogue persistence is tenant-scoped, concurrent and audit-atomic', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await cleanAll(pool);
    await pool.end();
  });
  await migrateUp(pool);
  const latestVersion = (await loadMigrations()).at(-1).version;
  assert.equal(await isPostgresSchemaReady(pool, latestVersion), true);
  await seed(pool);

  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });
  const organizationRepository = createPostgresTenantOrganizationRepository(pool, { auditRepository });
  const catalogueRepository = createPostgresTenantCatalogueRepository(pool, { auditRepository });
  const organizationService = createTenantOrganizationService({
    repository: organizationRepository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse('2026-08-27T12:00:00.000Z'),
  });
  const catalogueService = createTenantCatalogueService({
    repository: catalogueRepository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse('2026-08-27T12:00:00.000Z'),
  });
  const principalA = principal(TENANT_A, ADMIN_A);
  const tenantContextA = { tenantId: TENANT_A, status: 'active' };

  const initialOrganizationHistory = await organizationRepository.listHistory({
    tenantId: TENANT_A,
    limit: 10,
  });
  const initialCatalogueHistory = await catalogueRepository.listHistory({
    tenantId: TENANT_A,
    limit: 10,
  });
  assert.deepEqual(initialOrganizationHistory.map((entry) => entry.revision), [1]);
  assert.deepEqual(initialCatalogueHistory.map((entry) => entry.revision), [1]);

  const organizationResult = await organizationService.update({
    principal: principalA,
    tenantContext: tenantContextA,
    correlationId: CORRELATION_A,
    schemaVersion: 1,
    expectedRevision: 1,
    organization: organization('Changed Tenant A'),
  });
  assert.equal(organizationResult.revision, 2);
  assert.equal((await organizationRepository.loadCurrent(TENANT_B)).organization.displayName, 'Tenant B');

  const organizationRace = await Promise.allSettled([
    organizationService.update({
      principal: principalA,
      tenantContext: tenantContextA,
      correlationId: CORRELATION_A,
      schemaVersion: 1,
      expectedRevision: 2,
      organization: organization('Organization winner one'),
    }),
    organizationService.update({
      principal: principalA,
      tenantContext: tenantContextA,
      correlationId: CORRELATION_B,
      schemaVersion: 1,
      expectedRevision: 2,
      organization: organization('Organization winner two'),
    }),
  ]);
  assert.equal(organizationRace.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(organizationRace.filter((result) => result.reason instanceof TenantSettingsConflictError).length, 1);

  const catalogueResult = await catalogueService.update({
    principal: principalA,
    tenantContext: tenantContextA,
    correlationId: CORRELATION_A,
    schemaVersion: 1,
    expectedRevision: 1,
    catalogue: catalogue(),
  });
  assert.equal(catalogueResult.revision, 2);
  assert.equal((await catalogueRepository.loadCurrent(TENANT_B)).catalogue.services.length, 0);
  assert.equal(await catalogueRepository.scopeExists({
    tenantId: TENANT_A,
    siteId: SITE_B,
    roomId: ROOM_B,
  }), false);

  const snapshot = await catalogueService.snapshotForRequest({
    tenantId: TENANT_A,
    siteId: SITE_A,
    roomId: ROOM_A,
    selection: {
      serviceIds: ['video-support'],
      equipmentIds: ['projector'],
      cateringItemIds: [],
      catering: [{ packageId: 'meeting', variantId: 'premium', itemIds: ['coffee'] }],
    },
  });
  assert.equal(snapshot.catalogRevision, 2);
  assert.deepEqual(snapshot.services[0].price, { amountMinor: 2500, currency: 'EUR' });

  const forbiddenRemoval = await catalogueRepository.replace({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    correlationId: CORRELATION_A,
    expectedRevision: 2,
    catalogue: { ...catalogue(), services: [] },
    changedAt: new Date('2026-08-27T13:00:00.000Z'),
    auditEventFor() { throw new Error('MUST_NOT_AUDIT_FORBIDDEN_REMOVAL'); },
  });
  assert.equal(forbiddenRemoval.status, 'removal_forbidden');

  const failingRepository = createPostgresTenantCatalogueRepository(pool, {
    auditRepository: { async appendWithClient() { throw new Error('EXPECTED_AUDIT_FAILURE'); } },
  });
  await assert.rejects(
    failingRepository.replace({
      tenantId: TENANT_A,
      actorUserId: ADMIN_A,
      correlationId: CORRELATION_A,
      expectedRevision: 2,
      catalogue: catalogue('Must roll back'),
      changedAt: new Date('2026-08-27T14:00:00.000Z'),
      auditEventFor() { return auditService.createEvent({
        principal: principalA,
        tenantContext: tenantContextA,
        correlationId: CORRELATION_A,
        action: 'tenant.configuration.changed',
        targetType: 'catalogue',
        targetId: 'tenant-catalogue',
        previousState: { revision: 2 },
        newState: { revision: 3 },
        outcome: 'success',
        metadata: { operation: 'test' },
        retentionClass: 'administrative',
        occurredAt: '2026-08-27T14:00:00.000Z',
      }); },
    }),
    /EXPECTED_AUDIT_FAILURE/,
  );
  const afterAuditFailure = await catalogueRepository.loadCurrent(TENANT_A);
  assert.equal(afterAuditFailure.revision, 2);
  assert.equal(afterAuditFailure.catalogue.services[0].name, 'Video support');

  await assert.rejects(
    pool.query(
      `UPDATE tenant_catalogue_revisions
       SET effective_at = effective_at
       WHERE tenant_id = $1 AND revision = 1`,
      [TENANT_A],
    ),
    (error) => error.code === '55000',
  );
  const audits = await auditRepository.listByTenantId(TENANT_A, { limit: 100 });
  assert.equal(audits.filter((event) => event.action === 'tenant.configuration.changed').length, 3);

  let releaseCatalogueRead;
  let catalogueRevisionObserved;
  const catalogueRevisionRead = new Promise((resolve) => { catalogueRevisionObserved = resolve; });
  const continueCatalogueRead = new Promise((resolve) => { releaseCatalogueRead = resolve; });
  const pausingCataloguePool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      let paused = false;
      return {
        async query(statement, values) {
          const result = await client.query(statement, values);
          if (!paused && statement?.name === 'tenant-catalogue-current-tenant') {
            paused = true;
            catalogueRevisionObserved();
            await continueCatalogueRead;
          }
          return result;
        },
        release(error) { client.release(error); },
      };
    },
  };
  const pausingCatalogueRepository = createPostgresTenantCatalogueRepository(
    pausingCataloguePool,
    { auditRepository },
  );
  const inFlightCatalogueRead = pausingCatalogueRepository.loadCurrent(TENANT_A);
  await catalogueRevisionRead;
  try {
    const revisionThree = await catalogueService.update({
      principal: principalA,
      tenantContext: tenantContextA,
      correlationId: CORRELATION_B,
      schemaVersion: 1,
      expectedRevision: 2,
      catalogue: catalogue('Concurrent revision three'),
    });
    assert.equal(revisionThree.revision, 3);
  } finally {
    releaseCatalogueRead();
  }
  const coherentCatalogueRead = await inFlightCatalogueRead;
  assert.equal(coherentCatalogueRead.revision, 2);
  assert.equal(coherentCatalogueRead.catalogue.services[0].name, 'Video support');
  const currentCatalogue = await catalogueRepository.loadCurrent(TENANT_A);
  assert.equal(currentCatalogue.revision, 3);
  assert.equal(currentCatalogue.catalogue.services[0].name, 'Concurrent revision three');
});

test('migrations 022/023 reapply and refuse destructive rollback after domain use', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await cleanAll(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await seed(pool);
  await pool.query('UPDATE tenants SET catalog_revision = 2 WHERE id = $1', [TENANT_A]);
  await assert.rejects(
    rollbackToVersion(pool, 23),
    (error) => error.code === '55000' && error.message.includes('TENANT_CATALOGUE_ROLLBACK_REQUIRES_REVIEW'),
  );

  await pool.query('UPDATE tenants SET catalog_revision = 1 WHERE id = $1', [TENANT_A]);
  await cleanDomainData(pool);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool, 22), true);

  await pool.query('UPDATE tenants SET organization_revision = 2 WHERE id = $1', [TENANT_A]);
  await assert.rejects(
    rollbackLatest(pool),
    (error) => error.code === '55000'
      && error.message.includes('TENANT_ORGANIZATION_ROLLBACK_REQUIRES_REVIEW'),
  );

  await pool.query('UPDATE tenants SET organization_revision = 1 WHERE id = $1', [TENANT_A]);
  await disableDeleteEnable(
    pool,
    'tenant_organization_revisions',
    'tenant_organization_revisions_append_only',
  );
  await pool.query('DELETE FROM tenant_organization_settings WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await disableDeleteEnable(pool, 'audit_events', 'audit_events_append_only');
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANTS]);
  assert.equal(await rollbackLatest(pool), true);
  const precedingVersion = (await loadMigrations())
    .filter((migration) => migration.version < 22)
    .at(-1).version;
  assert.equal(await isPostgresSchemaReady(pool, precedingVersion), true);

  await migrateUp(pool);
  const latestVersion = (await loadMigrations()).at(-1).version;
  assert.equal(await isPostgresSchemaReady(pool, latestVersion), true);
});
