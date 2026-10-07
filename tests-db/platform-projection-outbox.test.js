import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresPlatformProjectionRepository } from '../src/persistence/postgres/platform-projection-repository.js';
import { subscribePlatformProjectionNotifications } from '../src/persistence/postgres/platform-projection-notifications.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';

const NORTHWIND = DEMO_FIXTURE.tenants[0].id;

test('outbox commits atomically, rebuilds current state, survives lost notifications and protects Tenant custody', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_outbox_${process.pid}`;
  const roles = Object.fromEntries(['customer', 'platform', 'reset'].map((surface) => [surface,
    `cm_outbox_${surface}_${process.pid}`]));
  let pool;
  let resetClient;
  let stopListener;
  t.after(async () => {
    try {
      await stopListener?.();
      if (resetClient) { await resetClient.query('RESET ROLE'); resetClient.release(); }
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
  const url = new URL(database.databaseUrl); url.pathname = `/${name}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString(), databasePoolMax: 6 });
  await migrateUp(pool);
  await migrateDemoUp(pool, { roles });
  resetClient = await pool.connect();
  await resetClient.query(`SET ROLE "${roles.reset}"`);
  const scoped = { query: (query, values) => resetClient.query(query, values), release() {} };
  const reset = createPostgresDemoResetRepository({
    pool: { query: scoped.query, async connect() { return scoped; } },
    expectedDatabaseName: name, expectedResetRole: roles.reset,
  });
  const input = { fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM };
  assert.equal((await reset.reset(input)).checksum, DEMO_FIXTURE_CHECKSUM);
  const repository = createPostgresPlatformProjectionRepository(pool);
  assert.equal((await repository.consumeBatch()).refreshedCount, 3);
  assert.equal((await repository.consumeBatch()).refreshedCount, 0);

  const permissions = await pool.query(`SELECT
    has_table_privilege($1, 'platform_projection_outbox', 'SELECT') AS customer_read,
    has_table_privilege($1, 'platform_projection_outbox', 'INSERT') AS customer_write,
    has_function_privilege($1, 'enqueue_platform_projection_invalidation()', 'EXECUTE') AS direct_execute,
    has_table_privilege($2, 'platform_projection_outbox', 'DELETE') AS worker_ack`, [roles.customer, roles.platform]);
  assert.deepEqual(permissions.rows[0], {
    customer_read: false, customer_write: false, direct_execute: false, worker_ack: true,
  });
  const sources = await pool.query(`SELECT count(*)::integer AS count FROM pg_trigger
    WHERE tgfoid = 'enqueue_platform_projection_invalidation()'::regprocedure AND NOT tgisinternal`);
  assert.equal(sources.rows[0].count, 7);

  let wakes = 0;
  stopListener = await subscribePlatformProjectionNotifications(pool, () => { wakes += 1; }, () => {});
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query(`SET LOCAL ROLE "${roles.customer}"`);
    await writer.query("UPDATE tenants SET display_name = 'Discarded change' WHERE id = $1", [NORTHWIND]);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM platform_projection_outbox')).rows[0].count, 0);
    await writer.query('ROLLBACK');
    assert.equal(wakes, 0);
    await writer.query('BEGIN');
    await writer.query(`SET LOCAL ROLE "${roles.customer}"`);
    for (const label of ['First committed revision', 'Latest committed revision']) {
      await writer.query('UPDATE tenants SET display_name = $2 WHERE id = $1', [NORTHWIND, label]);
    }
    await writer.query('COMMIT');
  } finally { writer.release(); }
  for (let attempt = 0; attempt < 50 && wakes === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(wakes, 1); // Identical wakeups coalesce inside the source transaction.
  let queued = await pool.query('SELECT tenant_id, source_version FROM platform_projection_outbox');
  assert.equal(queued.rowCount, 1); assert.equal(queued.rows[0].tenant_id, NORTHWIND);
  assert.equal(Number(queued.rows[0].source_version), 2);
  assert.equal((await pool.query(`SELECT readiness_state FROM platform_tenant_readiness_snapshots
    WHERE tenant_id = $1`, [NORTHWIND])).rows[0].readiness_state, 'stale');
  await stopListener(); stopListener = null;
  assert.equal((await repository.consumeBatch()).refreshedCount, 1);
  const revisions = await pool.query('SELECT tenant_id, revision FROM platform_tenant_readiness_snapshots ORDER BY tenant_id');
  assert.equal((await repository.consumeBatch()).refreshedCount, 0);
  assert.deepEqual((await pool.query('SELECT tenant_id, revision FROM platform_tenant_readiness_snapshots ORDER BY tenant_id')).rows,
    revisions.rows);

  // A mutation without any listener is still durable and consumed after restart.
  await pool.query('UPDATE microsoft365_capability_health SET last_checked_at = clock_timestamp() WHERE tenant_id = $1', [NORTHWIND]);
  const restarted = createPostgresPlatformProjectionRepository(pool);
  assert.equal((await restarted.consumeBatch()).refreshedCount, 1);

  // Concurrent consumers skip locked Tenant custody instead of duplicating a rebuild.
  await pool.query("UPDATE tenants SET display_name = 'Concurrent update' WHERE id = $1", [NORTHWIND]);
  const locked = await pool.connect();
  try {
    await locked.query('BEGIN');
    await locked.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [NORTHWIND]);
    assert.equal((await restarted.consumeBatch()).refreshedCount, 0);
    await locked.query('ROLLBACK');
  } finally { locked.release(); }
  assert.equal((await restarted.consumeBatch()).refreshedCount, 1);

  // Five failures retain poison evidence; a new committed state can be retried.
  await pool.query("UPDATE tenants SET display_name = 'Poison probe' WHERE id = $1", [NORTHWIND]);
  await pool.query(`CREATE FUNCTION reject_outbox_projection_test() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_PROJECTION_TEST_DETAIL'; END $$`);
  await pool.query(`CREATE TRIGGER reject_outbox_projection_test BEFORE UPDATE ON platform_tenant_readiness_snapshots
    FOR EACH ROW EXECUTE FUNCTION reject_outbox_projection_test()`);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await restarted.consumeBatch();
    assert.equal(result.refreshedCount, 0);
    assert.equal(result.poisonCount, attempt === 5 ? 1 : 0);
    queued = await pool.query('SELECT attempts, state, last_failure FROM platform_projection_outbox WHERE tenant_id = $1', [NORTHWIND]);
    assert.deepEqual(queued.rows[0], { attempts: attempt, state: attempt === 5 ? 'poison' : 'pending',
      last_failure: 'projection_failed' });
    if (attempt < 5) await pool.query(`UPDATE platform_projection_outbox SET available_at = clock_timestamp() WHERE tenant_id = $1`,
      [NORTHWIND]);
  }
  assert.equal((await restarted.consumeBatch()).poisonCount, 0);
  await assert.rejects(rollbackLatest(pool), /PLATFORM_PROJECTION_OUTBOX_ROLLBACK_REQUIRES_DRAIN/);
  await pool.query('DROP TRIGGER reject_outbox_projection_test ON platform_tenant_readiness_snapshots');
  await pool.query('DROP FUNCTION reject_outbox_projection_test()');
  await pool.query("UPDATE tenants SET display_name = 'Recovered committed source' WHERE id = $1", [NORTHWIND]);
  assert.equal((await restarted.consumeBatch()).refreshedCount, 1);
  assert.equal((await reset.reset(input)).checksum, DEMO_FIXTURE_CHECKSUM);
  assert.equal((await restarted.consumeBatch()).refreshedCount, 3);
  assert.equal(await rollbackLatest(pool), true);
});
