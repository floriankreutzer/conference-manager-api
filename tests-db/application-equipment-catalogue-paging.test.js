import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresApplicationRepository } from '../src/persistence/postgres/application-repository.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';
import { clearSaas3TestState } from './support/saas3-test-state.js';

const TENANT_A = 'a8111111-1111-4111-8111-111111111111';
const TENANT_B = 'a8222222-2222-4222-8222-222222222222';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';
const TENANTS = [TENANT_A, TENANT_B];
const AUDIT_KEY = 'equipment-catalogue-page-audit-key-32-bytes';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  for (const table of ['equipment_room_applicability', 'equipment_site_applicability']) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [TENANTS]);
  }
  await pool.query('DELETE FROM equipment WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await removeSaas2TenantAdministrationFixtures(pool, TENANTS);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANTS]);
}

async function seed(pool) {
  await pool.query({
    text: `
      INSERT INTO tenants (id, display_name, status)
      VALUES ($1, 'Equipment Tenant A', 'active'), ($2, 'Equipment Tenant B', 'active')
    `,
    values: TENANTS,
  });
  await pool.query({
    text: `
      INSERT INTO sites (tenant_id, id, name)
      VALUES ($1, $2, 'Site A'), ($3, $4, 'Site B')
    `,
    values: [TENANT_A, SITE_A, TENANT_B, SITE_B],
  });
  await pool.query({
    text: `
      INSERT INTO rooms (tenant_id, id, site_id, name, capacity)
      VALUES ($1, $2, $3, 'Room A', 20), ($4, $5, $6, 'Room B', 20)
    `,
    values: [TENANT_A, ROOM_A, SITE_A, TENANT_B, ROOM_B, SITE_B],
  });
  await pool.query({
    text: `
      INSERT INTO equipment (
        tenant_id, id, name, description, active, price_minor, currency, sort_order
      ) VALUES
        ($1, 'display', 'Tenant A display', 'Mobile display', TRUE, 1250, 'EUR', 50),
        ($1, 'inactive-equipment', 'Retired equipment', NULL, FALSE, 500, 'EUR', 2),
        ($1, 'projector', 'Tenant A projector', NULL, TRUE, 2500, 'GBP', 1),
        ($2, 'display', 'Tenant B display', 'Must stay private', TRUE, 999, 'USD', 3),
        ($2, 'foreign-only', 'Tenant B equipment', NULL, TRUE, 100, 'USD', 4)
    `,
    values: TENANTS,
  });
  await pool.query({
    text: `
      INSERT INTO equipment_site_applicability (tenant_id, equipment_id, site_id)
      VALUES ($1, 'display', $2), ($3, 'display', $4)
    `,
    values: [TENANT_A, SITE_A, TENANT_B, SITE_B],
  });
  await pool.query({
    text: `
      INSERT INTO equipment_room_applicability (tenant_id, equipment_id, room_id)
      VALUES ($1, 'display', $2), ($3, 'display', $4)
    `,
    values: [TENANT_A, ROOM_A, TENANT_B, ROOM_B],
  });
}

test('equipment catalogue pages are active-only, keyset-stable and hard tenant-scoped', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const repository = createPostgresApplicationRepository(pool, { auditRepository });
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  await clean(pool);
  await seed(pool);

  const first = await repository.loadCatalogPage({
    tenantId: TENANT_A,
    section: 'equipment',
    limit: 1,
  });
  assert.equal(first.status, 'ready');
  assert.deepEqual(first.entries, [{
    id: 'display',
    name: 'Tenant A display',
    description: 'Mobile display',
    active: true,
    order: 50,
    price: { amountMinor: 1250, currency: 'EUR' },
    siteIds: [SITE_A],
    roomIds: [ROOM_A],
  }]);

  const second = await repository.loadCatalogPage({
    tenantId: TENANT_A,
    section: 'equipment',
    afterId: first.entries[0].id,
    limit: 10,
    expectedRevisions: first.configurationRevisions,
    expectedPolicyVersionId: first.bookingPolicy.policyVersionId,
  });
  assert.equal(second.status, 'ready');
  assert.deepEqual(second.entries, [{
    id: 'projector',
    name: 'Tenant A projector',
    description: null,
    active: true,
    order: 1,
    price: { amountMinor: 2500, currency: 'GBP' },
    siteIds: [],
    roomIds: [],
  }]);

  const stale = await repository.loadCatalogPage({
    tenantId: TENANT_A,
    section: 'equipment',
    limit: 10,
    expectedRevisions: {
      ...first.configurationRevisions,
      catalogue: first.configurationRevisions.catalogue + 1,
    },
    expectedPolicyVersionId: first.bookingPolicy.policyVersionId,
  });
  assert.deepEqual(stale, { status: 'stale' });

  const tenantB = await repository.loadCatalogPage({
    tenantId: TENANT_B,
    section: 'equipment',
    limit: 10,
  });
  assert.deepEqual(tenantB.entries.map((entry) => entry.id), ['display', 'foreign-only']);
  assert.deepEqual(tenantB.entries[0].siteIds, [SITE_B]);
  assert.deepEqual(tenantB.entries[0].roomIds, [ROOM_B]);
  assert.equal(tenantB.entries.some((entry) => entry.name.startsWith('Tenant A')), false);
});
