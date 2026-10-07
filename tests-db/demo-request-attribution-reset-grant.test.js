import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDatabaseConfig } from '../src/config.js';
import { DEMO_OVERLAY_MIGRATION_VERSION } from '../src/demo/runtime-contract.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import {
  migrateDemoUp,
  rollbackLatestDemoMigration,
} from '../scripts/demo-db-migrations.mjs';
import { migrateUp } from '../scripts/db-migrations.mjs';

const ROLE_SUFFIX = String(process.pid);
const ROLES = Object.freeze({
  customer: `cm_demo_customer_${ROLE_SUFFIX}`,
  platform: `cm_demo_platform_${ROLE_SUFFIX}`,
  reset: `cm_demo_reset_${ROLE_SUFFIX}`,
});
const ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function identifier(value) {
  if (!ROLE_PATTERN.test(value)) throw new TypeError('DEMO_TEST_ROLE_INVALID');
  return `"${value}"`;
}

async function createRoles(pool) {
  for (const role of Object.values(ROLES)) {
    await pool.query(`CREATE ROLE ${identifier(role)} NOLOGIN`);
  }
}

async function overlayVersions(pool) {
  const present = await pool.query("SELECT to_regclass('public.demo_schema_migrations') AS ledger");
  if (present.rows[0].ledger === null) return [];
  const result = await pool.query(
    'SELECT version, name, char_length(checksum)::integer AS checksum_length '
      + 'FROM demo_schema_migrations ORDER BY version',
  );
  return result.rows;
}

async function rollbackOverlay(pool) {
  while ((await overlayVersions(pool)).length > 0) {
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true);
  }
}

async function dropRoles(pool) {
  for (const role of Object.values(ROLES).reverse()) {
    await pool.query(`DROP OWNED BY ${identifier(role)}`);
    await pool.query(`DROP ROLE IF EXISTS ${identifier(role)}`);
  }
}

async function privileges(pool, role) {
  const result = await pool.query({
    text: `
      SELECT
        has_table_privilege($1, 'public.request_attribution_migration_state', 'INSERT') AS insert_allowed,
        has_table_privilege($1, 'public.request_attribution_migration_state', 'TRUNCATE') AS truncate_allowed,
        has_table_privilege($1, 'public.request_attribution_migration_state', 'SELECT') AS select_allowed,
        has_table_privilege($1, 'public.request_attribution_migration_state', 'UPDATE') AS update_allowed,
        has_table_privilege($1, 'public.request_attribution_migration_state', 'DELETE') AS delete_allowed,
        has_table_privilege($1, 'public.request_attribution_migration_state', 'REFERENCES') AS references_allowed,
        has_table_privilege($1, 'public.request_attribution_migration_state', 'TRIGGER') AS trigger_allowed
    `,
    values: [role],
  });
  return result.rows[0];
}

async function resetAttributionStateAsRole(pool, role) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${identifier(role)}`);
    await client.query('TRUNCATE TABLE public.request_attribution_migration_state');
    await client.query(
      'INSERT INTO public.request_attribution_migration_state (singleton) VALUES (true)',
    );
    await client.query('ROLLBACK');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original privilege failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

test('Demo overlay 004 grants only the reset operations needed by request attribution state', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    try {
      await rollbackOverlay(pool);
    } finally {
      try {
        await dropRoles(pool);
      } finally {
        await pool.end();
      }
    }
  });

  await migrateUp(pool);
  await createRoles(pool);
  assert.equal(DEMO_OVERLAY_MIGRATION_VERSION, 9);

  await t.test('fresh install records all Demo overlays and permits the real reset sequence', async () => {
    await migrateDemoUp(pool, { roles: ROLES });
    assert.deepEqual(await overlayVersions(pool), [
      { version: 1, name: 'demo_runtime_foundation', checksum_length: 64 },
      { version: 2, name: 'runtime_readiness_grants', checksum_length: 64 },
      { version: 3, name: 'runtime_schema_readiness_grants', checksum_length: 64 },
      { version: 4, name: 'request_attribution_reset_grants', checksum_length: 64 },
      { version: 5, name: 'room_media_role_grants', checksum_length: 64 },
      { version: 6, name: 'demo_catalogue_media', checksum_length: 64 },
      { version: 7, name: 'demo_catalogue_media_create', checksum_length: 64 },
      { version: 8, name: 'private_media_metadata', checksum_length: 64 },
      { version: 9, name: 'projection_outbox_privileges', checksum_length: 64 },
    ]);
    assert.deepEqual(await privileges(pool, ROLES.reset), {
      insert_allowed: true,
      truncate_allowed: true,
      select_allowed: false,
      update_allowed: false,
      delete_allowed: false,
      references_allowed: false,
      trigger_allowed: false,
    });
    for (const role of [ROLES.customer, ROLES.platform]) {
      assert.deepEqual(await privileges(pool, role), {
        insert_allowed: false,
        truncate_allowed: false,
        select_allowed: false,
        update_allowed: false,
        delete_allowed: false,
        references_allowed: false,
        trigger_allowed: false,
      });
    }
    await resetAttributionStateAsRole(pool, ROLES.reset);
  });

  await t.test('upgrade from 001..003 is denied before 004 and restored by the checksum runner', async () => {
    for (let index = 0; index < 6; index += 1) {
      assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true);
    }
    assert.deepEqual((await overlayVersions(pool)).map(({ version }) => version), [1, 2, 3]);
    assert.deepEqual(await privileges(pool, ROLES.reset), {
      insert_allowed: false,
      truncate_allowed: false,
      select_allowed: false,
      update_allowed: false,
      delete_allowed: false,
      references_allowed: false,
      trigger_allowed: false,
    });
    await assert.rejects(
      resetAttributionStateAsRole(pool, ROLES.reset),
      (error) => error.code === '42501',
    );
    await migrateDemoUp(pool, { roles: ROLES });
    assert.deepEqual((await overlayVersions(pool)).map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await resetAttributionStateAsRole(pool, ROLES.reset);
  });

  await t.test('private media overlay preserves inventory across reset and denies Platform or destructive runtime access', async () => {
    for (const [purpose, role] of Object.entries(ROLES)) {
      const result = await pool.query(`SELECT
        has_table_privilege($1, 'media_object_inventory', 'SELECT') AS read,
        has_table_privilege($1, 'media_object_inventory', 'INSERT') AS register,
        has_column_privilege($1, 'media_object_inventory', 'object_key', 'UPDATE') AS row_lock,
        has_column_privilege($1, 'media_object_inventory', 'registered_at', 'UPDATE') AS change_age,
        has_table_privilege($1, 'media_object_inventory', 'DELETE') AS delete,
        has_table_privilege($1, 'media_object_inventory', 'TRUNCATE') AS truncate`, [role]);
      assert.deepEqual(result.rows[0], { read: purpose !== 'platform', register: purpose !== 'platform',
        row_lock: purpose !== 'platform', change_age: false, delete: false, truncate: false });
    }
    for (const role of [ROLES.customer, ROLES.reset]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${identifier(role)}`);
        await assert.rejects(client.query('TRUNCATE media_object_inventory'), (error) => error.code === '42501');
        await client.query('ROLLBACK');
      } finally { client.release(); }
    }
  });
});
