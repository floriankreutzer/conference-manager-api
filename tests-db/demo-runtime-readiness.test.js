import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresDemoRuntimeReadiness } from '../src/persistence/postgres/demo-runtime-readiness.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';

test('bounded Demo readiness detects authority loss and surplus inventory in real PostgreSQL', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_ready_${process.pid}`;
  const roles = Object.fromEntries(['customer', 'platform', 'reset'].map((surface) => [surface,
    `cm_ready_${surface}_${process.pid}`]));
  let pool;
  t.after(async () => {
    try {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
  const url = new URL(database.databaseUrl); url.pathname = `/${name}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString() });
  await migrateUp(pool);
  await migrateDemoUp(pool, { roles });
  const resetClient = await pool.connect();
  try {
    await resetClient.query(`SET ROLE "${roles.reset}"`);
    const scoped = { query: (query, values) => resetClient.query(query, values), release() {} };
    const reset = createPostgresDemoResetRepository({
      pool: { query: scoped.query, async connect() { return scoped; } },
      expectedDatabaseName: name, expectedResetRole: roles.reset,
    });
    assert.equal((await reset.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM })).checksum,
      DEMO_FIXTURE_CHECKSUM);
  } finally { await resetClient.query('RESET ROLE'); resetClient.release(); }

  for (const surface of ['customer', 'platform']) {
    const client = await pool.connect();
    const readiness = createPostgresDemoRuntimeReadiness({
      pool: { query: (query) => client.query(query) }, surface,
      expectedDatabaseName: name, expectedRole: roles[surface],
      expectedSentinelKey: 'conference-manager-shared-demo-v1',
    });
    try {
      await client.query(`SET ROLE "${roles[surface]}"`);
      assert.equal(await readiness.assertReady(), true);
      assert.equal(await readiness.isReady(), true);
      await client.query('RESET ROLE');
      await client.query('BEGIN');
      if (surface === 'customer') {
        await client.query(`UPDATE users SET active = false, security_version = security_version + 1,
          lifecycle_revision = lifecycle_revision + 1 WHERE id =
          (SELECT subject_id FROM demo_customer_persona_references LIMIT 1)`);
      } else {
        await client.query(`UPDATE platform_operators SET status = 'disabled' WHERE id =
          (SELECT operator_id FROM demo_platform_persona_references LIMIT 1)`);
      }
      await client.query(`SET LOCAL ROLE "${roles[surface]}"`);
      assert.equal(await readiness.isReady(), false);
      await assert.rejects(readiness.assertReady(), /DEMO_RUNTIME_NOT_READY/);
      await client.query('ROLLBACK');
      await client.query(`SET ROLE "${roles[surface]}"`);
      assert.equal(await readiness.isReady(), true);
      await client.query('RESET ROLE');

      for (const probe of ['persona', 'overlay']) {
        await client.query('BEGIN');
        if (probe === 'persona') {
          await client.query(`INSERT INTO demo_persona_references
            SELECT surface, 'readiness-surplus-probe', tenant_id, 'readiness_probe', subject_id,
              provider, provider_tenant_reference, provider_subject_reference, assurance_level,
              authentication_context FROM demo_persona_references WHERE surface = $1 LIMIT 1`, [surface]);
        } else {
          await client.query(`INSERT INTO demo_schema_migrations (version, name, checksum)
            SELECT 999, 'readiness_surplus_probe', checksum FROM demo_schema_migrations LIMIT 1`);
        }
        await client.query(`SET LOCAL ROLE "${roles[surface]}"`);
        assert.equal(await readiness.isReady(), false);
        await assert.rejects(readiness.assertReady(), /DEMO_RUNTIME_NOT_READY/);
        await client.query('ROLLBACK');
      }
      await client.query(`SET ROLE "${roles[surface]}"`);
      assert.equal(await readiness.isReady(), true);
      assert.equal(await readiness.assertReady(), true);
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      client.release();
    }
  }
});
