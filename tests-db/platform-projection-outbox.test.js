import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresPlatformProjectionRepository } from '../src/persistence/postgres/platform-projection-repository.js';
import { subscribePlatformProjectionNotifications } from '../src/persistence/postgres/platform-projection-notifications.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { migrateDemoUp, rollbackLatestDemoMigration } from '../scripts/demo-db-migrations.mjs';

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
    has_table_privilege($2, 'platform_projection_outbox', 'DELETE') AS worker_ack,
    has_table_privilege($1, 'catering_integration_configurations', 'UPDATE') AS catering_config_write,
    has_table_privilege($1, 'catering_integration_configuration_revisions', 'UPDATE') AS catering_history_update,
    has_table_privilege($2, 'catering_integration_configurations', 'SELECT') AS platform_catering_read,
    has_table_privilege($3, 'catering_integration_configuration_revisions', 'TRUNCATE') AS reset_catering_truncate,
    has_table_privilege($1, 'catering_catalogue_assignment_heads', 'UPDATE') AS assignment_head_write,
    has_table_privilege($1, 'catering_catalogue_assignment_entries', 'INSERT') AS assignment_entry_insert,
    has_table_privilege($1, 'catering_catalogue_assignment_revisions', 'UPDATE') AS assignment_history_update,
    has_table_privilege($1, 'catering_catalogue_assignment_seals', 'INSERT') AS assignment_seal_insert,
    has_table_privilege($2, 'catering_catalogue_assignment_heads', 'SELECT') AS platform_assignment_read,
    has_table_privilege($3, 'catering_catalogue_assignment_seals', 'TRUNCATE') AS reset_assignment_truncate,
    has_function_privilege($1, 'verify_catering_catalogue_assignment_revision()', 'EXECUTE') AS direct_assignment_seal,
    has_table_privilege($1, 'catering_order_version_states', 'UPDATE') AS order_state_write,
    has_table_privilege($1, 'catering_order_positions', 'INSERT') AS order_position_insert,
    has_table_privilege($1, 'catering_order_versions', 'UPDATE') AS order_history_update,
    has_table_privilege($1, 'catering_order_version_seals', 'INSERT') AS order_seal_insert,
    has_table_privilege($2, 'catering_orders', 'SELECT') AS platform_order_read,
    has_table_privilege($3, 'catering_order_decisions', 'TRUNCATE') AS reset_order_truncate,
    has_function_privilege($1, 'verify_catering_order_version()', 'EXECUTE') AS direct_order_seal`,
  [roles.customer, roles.platform, roles.reset]);
  assert.deepEqual(permissions.rows[0], {
    customer_read: false, customer_write: false, direct_execute: false, worker_ack: true,
    catering_config_write: true, catering_history_update: false, platform_catering_read: false, reset_catering_truncate: true,
    assignment_head_write: true, assignment_entry_insert: true, assignment_history_update: false,
    assignment_seal_insert: false, platform_assignment_read: false, reset_assignment_truncate: true, direct_assignment_seal: false,
    order_state_write: true, order_position_insert: true, order_history_update: false, order_seal_insert: false,
    platform_order_read: false, reset_order_truncate: true, direct_order_seal: false,
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
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Catalogue source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Platform passkey reset grants019 before schema053.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Unsent grants018 before schema052.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Version grants overlay017.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Manual grants overlay 016.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering delivery grants overlay 015.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering order grants overlay 014.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering assignment grants overlay 013.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering grants overlay 012.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Product-source overlay 011.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Lifecycle grants overlay 010.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering delivery schema 049.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering order schema 048.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering assignment schema 047.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering configuration schema 046.
  assert.equal(await rollbackLatest(pool), true); // Empty Request lifecycle schema 045.
  await assert.rejects(rollbackLatest(pool), /PLATFORM_PROJECTION_OUTBOX_ROLLBACK_REQUIRES_DRAIN/);
  await migrateUp(pool); // Restore the current reset readiness contract after the 044 guard probe.
  await migrateDemoUp(pool, { roles });
  await pool.query('DROP TRIGGER reject_outbox_projection_test ON platform_tenant_readiness_snapshots');
  await pool.query('DROP FUNCTION reject_outbox_projection_test()');
  await pool.query("UPDATE tenants SET display_name = 'Recovered committed source' WHERE id = $1", [NORTHWIND]);
  assert.equal((await restarted.consumeBatch()).refreshedCount, 1);
  const cateringIntegration = 'c0000000-0000-4000-8000-000000000099';
  const cateringOrder = 'c0000000-0000-4000-8000-000000000096';
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(`SET LOCAL ROLE "${roles.customer}"`);
    await setup.query(`INSERT INTO integrations (tenant_id,id,provider,provider_reference,status)
      VALUES ($1,$2,'manual_catering','synthetic-reset-catering','configured')`, [NORTHWIND, cateringIntegration]);
    await setup.query(`INSERT INTO catering_integration_configurations (tenant_id,integration_id,revision,initial_order_mode,
      catalogue_mode,availability_mode,order_mode,update_mode,cancel_mode,status_mode,created_at,updated_at,updated_by_user_id)
      SELECT tenant_id,$2,1,'manager_review','manual','manual','manual','manual','manual','manual',
      transaction_timestamp(),transaction_timestamp(),id FROM users WHERE tenant_id=$1 ORDER BY id LIMIT 1`,
    [NORTHWIND, cateringIntegration]);
    await setup.query(`INSERT INTO catering_integration_configuration_revisions SELECT configuration.*, $3::uuid
      FROM catering_integration_configurations configuration WHERE tenant_id=$1 AND integration_id=$2`,
    [NORTHWIND, cateringIntegration, 'c0000000-0000-4000-8000-000000000098']);
    const canonical = (await setup.query(`SELECT tenant.catalog_revision, catalogue.snapshot,
      (SELECT id FROM users WHERE tenant_id=$1 ORDER BY id LIMIT 1) AS actor_user_id FROM tenants tenant
      JOIN tenant_catalogue_revisions catalogue ON catalogue.tenant_id=tenant.id AND catalogue.revision=tenant.catalog_revision
      WHERE tenant.id=$1`, [NORTHWIND])).rows[0];
    const ownership = [
      ...canonical.snapshot.cateringItems.map((entry) => ({ kind: 'item', id: entry.id })),
      ...canonical.snapshot.cateringPackages.map((entry) => ({ kind: 'package', id: entry.id })),
    ];
    await setup.query(`INSERT INTO catering_catalogue_assignment_revisions
      (tenant_id,revision,catalogue_revision,entry_count,changed_at,changed_by_user_id,correlation_id)
      VALUES ($1,1,$2,$3,transaction_timestamp(),$4,$5)`,
    [NORTHWIND, canonical.catalog_revision, ownership.length, canonical.actor_user_id, 'c0000000-0000-4000-8000-000000000097']);
    await setup.query(`INSERT INTO catering_catalogue_assignment_entries (tenant_id,revision,kind,entry_id,integration_id)
      SELECT $1,1,kind,entry_id,$2 FROM unnest($3::text[],$4::text[]) entries(kind,entry_id)`,
    [NORTHWIND, cateringIntegration, ownership.map((entry) => entry.kind), ownership.map((entry) => entry.id)]);
    await setup.query('INSERT INTO catering_catalogue_assignment_heads (tenant_id,revision) VALUES ($1,1)', [NORTHWIND]);
    await setup.query('COMMIT');
    await setup.query('BEGIN');
    await setup.query(`SET LOCAL ROLE "${roles.customer}"`);
    const source = (await setup.query(`SELECT request.id,request.request_version,revision.record
      FROM requests request JOIN request_revisions revision ON revision.tenant_id=request.tenant_id
        AND revision.request_id=request.id AND revision.request_version=request.request_version
      WHERE request.tenant_id=$1 AND request.status='Confirmed'
        AND (revision.record->'configurationRevisions'->>'catalogue')::bigint=$2
        AND (jsonb_typeof(revision.record->'pricing'->'catering'->'packageSelection')='object'
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(revision.record->'pricing'->'catering'->'items') line
            WHERE line->>'includedByPackage'='false')) ORDER BY request.id LIMIT 1`,
    [NORTHWIND, canonical.catalog_revision])).rows[0];
    assert.ok(source, 'The deterministic Northwind source must provide a confirmed Catering fixture for role/reset acceptance.');
    const catering = source.record.pricing.catering;
    const lines = [
      ...(catering.packageSelection ? [{ kind: 'package', id: catering.packageSelection.package.id,
        total: catering.packageSelection.lineTotalMinor }] : []),
      ...catering.items.filter((line) => !line.includedByPackage).map((line) => ({ kind: 'item', id: line.item.id,
        total: line.lineTotalMinor })),
    ];
    await setup.query(`INSERT INTO catering_orders(tenant_id,id,request_id,integration_id,created_at,created_by_user_id,
      creation_command_id,correlation_id) VALUES ($1,$2,$3,$4,clock_timestamp(),$5,$6,$7)`,
    [NORTHWIND, cateringOrder, source.id, cateringIntegration, canonical.actor_user_id,
      'c0000000-0000-4000-8000-000000000095', 'c0000000-0000-4000-8000-000000000094']);
    await setup.query(`INSERT INTO catering_order_versions(tenant_id,order_id,version,request_id,request_version,integration_id,
      assignment_revision,catalogue_revision,configuration_revision,operation,position_count,conference_total_minor,currency,
      created_at,created_by_user_id,correlation_id) VALUES ($1,$2,1,$3,$4,$5,1,$6,1,'initial',$7,$8,$9,clock_timestamp(),$10,$11)`,
    [NORTHWIND, cateringOrder, source.id, source.request_version, cateringIntegration, canonical.catalog_revision, lines.length,
      lines.reduce((sum, line) => sum + line.total, 0), source.record.pricing.currency, canonical.actor_user_id,
      'c0000000-0000-4000-8000-000000000094']);
    for (const [index, line] of lines.entries()) await setup.query(`INSERT INTO catering_order_positions
      (tenant_id,order_id,version,position_id,kind,entry_id) VALUES ($1,$2,1,$3,$4,$5)`,
    [NORTHWIND, cateringOrder, `c0000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`, line.kind, line.id]);
    await setup.query('INSERT INTO catering_order_heads(tenant_id,order_id,current_version) VALUES ($1,$2,1)', [NORTHWIND, cateringOrder]);
    await setup.query(`INSERT INTO catering_order_version_states(tenant_id,order_id,version,revision,status,updated_at)
      VALUES ($1,$2,1,1,'pending_quote',clock_timestamp())`, [NORTHWIND, cateringOrder]);
    await setup.query('COMMIT');
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_order_version_seals')).rows[0].count, 1);
    for (const [sql, code] of [
      ["INSERT INTO catering_catalogue_assignment_seals (tenant_id,revision) VALUES ($1,1)", '42501'],
      [`INSERT INTO catering_catalogue_assignment_entries (tenant_id,revision,kind,entry_id,integration_id)
        VALUES ($1,1,'item','late-append','${cateringIntegration}')`, '55000'],
      [`INSERT INTO catering_order_version_seals(tenant_id,order_id,version) VALUES ($1,'${cateringOrder}',1)`, '42501'],
      [`UPDATE catering_order_versions SET position_count=position_count WHERE tenant_id=$1 AND order_id='${cateringOrder}'`, '42501'],
      [`INSERT INTO catering_order_positions(tenant_id,order_id,version,position_id,kind,entry_id)
        VALUES ($1,'${cateringOrder}',1,'c0000000-0000-4000-8000-000000000093','item','late-entry')`, '55000'],
    ]) {
      await setup.query('BEGIN');
      await setup.query(`SET LOCAL ROLE "${roles.customer}"`);
      await assert.rejects(setup.query(sql, [NORTHWIND]), (error) => error.code === code);
      await setup.query('ROLLBACK');
    }
  } finally { setup.release(); }
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_integration_configurations')).rows[0].count, 1);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_catalogue_assignment_seals')).rows[0].count, 1);
  assert.equal((await reset.reset(input)).checksum, DEMO_FIXTURE_CHECKSUM);
  for (const table of ['catering_catalogue_assignment_heads', 'catering_catalogue_assignment_entries',
    'catering_catalogue_assignment_seals', 'catering_catalogue_assignment_revisions',
    'catering_orders','catering_order_versions','catering_order_positions','catering_order_version_seals',
    'catering_order_heads','catering_order_quotes','catering_order_decisions','catering_order_version_states']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
  }
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_integration_configurations')).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_integration_configuration_revisions')).rows[0].count, 0);
  assert.equal((await restarted.consumeBatch()).refreshedCount, 3);
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Catalogue source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Platform passkey reset grants019 before schema053.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Unsent grants018 before schema052.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Version grants overlay017.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Manual grants overlay 016.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering delivery grants overlay 015.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering order grants overlay 014.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering assignment grants overlay 013.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catering grants overlay 012.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true);
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true);
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering delivery schema 049.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering order schema 048.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering assignment schema 047.
  assert.equal(await rollbackLatest(pool), true); // Empty Catering configuration schema 046.
  assert.equal(await rollbackLatest(pool), true); // Empty Request lifecycle schema 045.
  assert.equal(await rollbackLatest(pool), true);
});
