import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withDemoMetricsMigrationGate } from '../src/persistence/postgres/demo-metrics-migration-gate.js';
import { DEMO_RUNTIME_ADVISORY_LOCK } from '../src/demo/runtime-contract.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';

test('reviewed metrics upgrade preserves retained Demo data, excludes concurrent runtime and verifies migration identity', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_metrics_${process.pid}`;
  const roles = Object.fromEntries(['customer', 'platform', 'reset', 'migration'].map((surface) => [surface,
    `cm_metrics_${surface}_${process.pid}`]));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cm-metrics-migrations-'));
  let raw;
  t.after(async () => {
    try {
      await raw?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await rm(directory, { recursive: true, force: true });
    } finally { await admin.end(); }
  });
  for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
  await admin.query(`CREATE DATABASE "${name}" OWNER "${roles.migration}"`);
  const url = new URL(database.databaseUrl); url.pathname = `/${name}`;
  raw = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString() });
  const pool = { async connect() {
    const client = await raw.connect();
    await client.query(`SET ROLE "${roles.migration}"`);
    return client;
  } };
  for (const [source, maximum] of [['migrations', 44], ['demo-migrations', 9]]) {
    await mkdir(path.join(directory, source));
    for (const filename of await readdir(source)) {
      if (Number(filename.slice(0, 3)) <= maximum) await copyFile(path.join(source, filename), path.join(directory, source, filename));
    }
  }
  await migrateUp(pool, path.join(directory, 'migrations'));
  const runtimeRoles = { customer: roles.customer, platform: roles.platform, reset: roles.reset };
  // The historical overlay runner required 044; apply its exact checked SQL through the canonical runner for this fixture.
  // Demo-specific role settings and the separate ledger remain distinct.
  const historical = await import('../scripts/db-migrations.mjs');
  const overlays = await historical.loadMigrations(path.join(directory, 'demo-migrations'));
  const setup = await pool.connect();
  try {
    await setup.query(`CREATE TABLE demo_schema_migrations (version integer PRIMARY KEY,
      name varchar(128) NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    for (const migration of overlays) {
      await setup.query('BEGIN');
      for (const [surface, role] of Object.entries(runtimeRoles)) {
        await setup.query('SELECT set_config($1, $2, true)', [`conference_manager.demo_${surface}_role`, role]);
      }
      await setup.query(migration.up);
      await setup.query('INSERT INTO demo_schema_migrations(version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum]);
      await setup.query('COMMIT');
    }
    await setup.query('INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
      ['11111111-1111-4111-8111-111111111111', 'Synthetic retained migration tenant', 'pending']);
  } finally { setup.release(); }
  const expected = { ...roles, database: name };
  let upgrades = 0;
  const upgrade = async () => {
    upgrades += 1;
    const contender = await raw.connect();
    try {
      const locked = await contender.query('SELECT pg_try_advisory_lock_shared($1) AS acquired', [DEMO_RUNTIME_ADVISORY_LOCK]);
      assert.equal(locked.rows[0].acquired, false);
    } finally { contender.release(); }
    await migrateUp(pool);
    await migrateDemoUp(pool, { roles: runtimeRoles });
  };
  await assert.rejects(withDemoMetricsMigrationGate(pool, { ...expected, customer: 'cm_wrong_customer' }, upgrade), /PRECONDITIONS/);
  assert.equal(upgrades, 0);
  assert.deepEqual(await withDemoMetricsMigrationGate(pool, expected, upgrade), {
    canonicalVersion: 62, demoVersion: 27, resetPerformed: false, retainedCountsMatch: true,
  });
  assert.equal(upgrades, 1);
  assert.equal((await raw.query('SELECT count(*)::integer AS count FROM tenants')).rows[0].count, 1);
  assert.equal((await withDemoMetricsMigrationGate(pool, expected, upgrade)).retainedCountsMatch, true);
  assert.equal(upgrades, 2);
  for (const [table, version] of [['schema_migrations', 63], ['demo_schema_migrations', 28]]) {
    await raw.query(`INSERT INTO ${table}(version,name,checksum) VALUES ($1,'synthetic_future_schema',repeat('a',64))`, [version]);
    try {
      await assert.rejects(withDemoMetricsMigrationGate(pool, expected, upgrade), /PRECONDITIONS/);
      assert.equal(upgrades, 2);
    } finally { await raw.query(`DELETE FROM ${table} WHERE version=$1`, [version]); }
  }
  const sourceLock = (await raw.query('DELETE FROM schema_migrations WHERE version=62 RETURNING *')).rows[0];
  const handoff = (await raw.query('DELETE FROM schema_migrations WHERE version=61 RETURNING *')).rows[0];
  await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/); // Retained060 cannot admit027.
  const handoffOverlay = (await raw.query('DELETE FROM demo_schema_migrations WHERE version=27 RETURNING *')).rows[0];
  const syntheticMedia = (await raw.query('DELETE FROM schema_migrations WHERE version=60 RETURNING *')).rows[0];
  await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/); // Retained059 cannot admit026.
  const syntheticMediaOverlay = (await raw.query('DELETE FROM demo_schema_migrations WHERE version=26 RETURNING *')).rows[0];
  const protectedRuntime = (await raw.query('DELETE FROM schema_migrations WHERE version=59 RETURNING *')).rows[0];
  await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/); // Retained058 cannot admit025.
  const protectedOverlay = (await raw.query('DELETE FROM demo_schema_migrations WHERE version=25 RETURNING *')).rows[0];
  const microsoft = (await raw.query('DELETE FROM schema_migrations WHERE version=58 RETURNING *')).rows[0];
  await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/); // Retained057 cannot admit024.
  const microsoftOverlay = (await raw.query('DELETE FROM demo_schema_migrations WHERE version=24 RETURNING *')).rows[0];
  const customer = (await raw.query('DELETE FROM schema_migrations WHERE version=57 RETURNING *')).rows[0];
  await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/); // Retained056 cannot admit023.
  const customerOverlay = (await raw.query('DELETE FROM demo_schema_migrations WHERE version=23 RETURNING *')).rows[0];
  const enrollment = (await raw.query('DELETE FROM schema_migrations WHERE version=56 RETURNING *')).rows[0];
  await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/); // Retained055 cannot admit022.
  const enrollmentOverlay = (await raw.query('DELETE FROM demo_schema_migrations WHERE version=22 RETURNING *')).rows[0];
  const removed = (await raw.query('DELETE FROM schema_migrations WHERE version=55 RETURNING *')).rows[0];
  try {
    // A contiguous054 ledger must not admit the future021 grants, even with retained tables.
    await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/);
    assert.equal(upgrades,2);
    const previous = (await raw.query('DELETE FROM schema_migrations WHERE version=54 RETURNING *')).rows[0];
    const overlay = (await raw.query('DELETE FROM demo_schema_migrations WHERE version=21 RETURNING *')).rows[0];
    try {
      // Retain the independently accepted053/020 incompatibility negative as well.
      await assert.rejects(withDemoMetricsMigrationGate(pool,expected,upgrade),/PRECONDITIONS/);
      assert.equal(upgrades,2);
    } finally {
      await raw.query('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)',
        [previous.version,previous.name,previous.checksum,previous.applied_at]);
      await raw.query('INSERT INTO demo_schema_migrations(version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)',
        [overlay.version,overlay.name,overlay.checksum,overlay.applied_at]);
    }
  } finally {
    await raw.query('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)',
      [removed.version,removed.name,removed.checksum,removed.applied_at]);
    for (const [table,row] of [['schema_migrations',enrollment],['demo_schema_migrations',enrollmentOverlay],
      ['schema_migrations',customer],['demo_schema_migrations',customerOverlay],
      ['schema_migrations',microsoft],['demo_schema_migrations',microsoftOverlay],
      ['schema_migrations',protectedRuntime],['demo_schema_migrations',protectedOverlay],
      ['schema_migrations',syntheticMedia],['demo_schema_migrations',syntheticMediaOverlay],
      ['schema_migrations',handoff],['demo_schema_migrations',handoffOverlay],['schema_migrations',sourceLock]]) {
      await raw.query(`INSERT INTO ${table}(version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)`,
        [row.version,row.name,row.checksum,row.applied_at]);
    }
  }
  const releaseClient = await raw.connect();
  try {
    const releaseCheck = await releaseClient.query('SELECT pg_try_advisory_lock_shared($1) AS acquired', [DEMO_RUNTIME_ADVISORY_LOCK]);
    assert.equal(releaseCheck.rows[0].acquired, true);
    await releaseClient.query('SELECT pg_advisory_unlock_shared($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
  } finally { releaseClient.release(); }
});
