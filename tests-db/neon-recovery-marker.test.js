import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadDatabaseConfig } from '../src/config.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM, semanticChecksum } from '../src/demo/fixture.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { readDemoSemanticState } from '../src/persistence/postgres/demo-fixture-state.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';
import { assertNeonRecoveryIdentity, RECOVERY_ROLES } from '../scripts/support/neon-recovery-config.mjs';
import { verifyRestoredSemanticState } from '../scripts/support/neon-recovery-media.mjs';

const DATABASE = 'conference_manager_demo_shared';
const BRANCH = 'br-disposable-recovery-test';
const ROLES = Object.freeze({
  customer: RECOVERY_ROLES.DEMO_CUSTOMER_DATABASE_URL,
  platform: RECOVERY_ROLES.DEMO_PLATFORM_DATABASE_URL,
  reset: RECOVERY_ROLES.DEMO_RESET_DATABASE_URL,
  migration: RECOVERY_ROLES.DEMO_MIGRATION_DATABASE_URL,
});

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) throw new Error('RECOVERY_TEST_IDENTIFIER_INVALID');
  return `"${value}"`;
}

function heldClientPool(client) {
  const held = { query: (query, values) => client.query(query, values), release() {} };
  return { query: held.query, async connect() { return held; } };
}

test('constant recovery view survives two canonical resets while table and owner mistakes fail closed', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const url = new URL(database.databaseUrl);
  // The exact recovery identity needs this fixed database and migration role.
  // Never reuse or remove an existing instance; run only under the isolated local DB test runner.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/conference_manager_test_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error('RECOVERY_TEST_DATABASE_INVALID');
  }
  const admin = createPostgresPool({ mode: 'test', ...database });
  const observer = `cm_recovery_observer_${process.pid}`;
  const createdRoles = [];
  const clients = new Map();
  let databaseCreated = false;
  let pool;
  t.after(async () => {
    try {
      const released = await Promise.allSettled([...clients.values()].map(async (client) => {
        try {
          await client.query('ROLLBACK');
          await client.query('RESET ROLE');
        } finally { client.release(); }
      }));
      await pool?.end();
      if (databaseCreated) await admin.query(`DROP DATABASE ${identifier(DATABASE)} WITH (FORCE)`);
      for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE ${identifier(role)}`);
      assert.equal(released.every(({ status }) => status === 'fulfilled'), true);
    } finally { await admin.end(); }
  });

  for (const role of [...Object.values(ROLES), observer]) {
    await admin.query(`CREATE ROLE ${identifier(role)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE ${identifier(DATABASE)} OWNER ${identifier(ROLES.migration)}`);
  databaseCreated = true;
  url.pathname = `/${DATABASE}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString(), databasePoolMax: 6 });
  for (const role of [...Object.values(ROLES), observer]) {
    const client = await pool.connect();
    clients.set(role, client);
    await client.query(`SET ROLE ${identifier(role)}`);
  }
  const migration = clients.get(ROLES.migration);
  const migrationPool = heldClientPool(migration);
  await migrateUp(migrationPool);
  await migrateDemoUp(migrationPool, { roles: ROLES });

  const instructions = await readFile(new URL('../docs/NEON-PAIRED-RECOVERY-ACCEPTANCE.md', import.meta.url), 'utf8');
  const markerBlocks = [...instructions.matchAll(/^```sql neon-recovery-marker-installation\n([\s\S]*?)\n```$/gm)];
  assert.equal(markerBlocks.length, 1, 'The runbook must contain exactly one named marker installation block.');
  const definition = markerBlocks[0][1];
  assert.ok(definition, 'The operator runbook must contain its executable marker installation.');
  const install = definition.replace('<VERIFIED_CHILD_ID>', BRANCH);
  const inventory = () => pool.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  const tablesBefore = (await inventory()).rows;
  await migration.query(install);
  assert.deepEqual((await inventory()).rows, tablesBefore);
  const markerQuery = 'SELECT * FROM public.neon_recovery_acceptance';
  const markerBefore = (await migration.query(markerQuery)).rows;
  assert.equal(markerBefore.length, 1);
  const expires = markerBefore[0].expires_at.getTime();
  assert.equal(expires - markerBefore[0].created_at.getTime(), 60 * 60_000);

  await assert.rejects(migration.query(install), { code: '42P07' });
  await migration.query('ROLLBACK');
  assert.deepEqual((await migration.query(markerQuery)).rows, markerBefore);
  const observerPrivilege = await migration.query(`SELECT
    pg_catalog.has_table_privilege($1::name, 'public.neon_recovery_acceptance', 'SELECT') AS readable`, [observer]);
  assert.deepEqual(observerPrivilege.rows, [{ readable: false }]);
  await assert.rejects(clients.get(observer).query(markerQuery), { code: '42501' });
  for (const role of Object.values(ROLES)) {
    const client = clients.get(role);
    assert.equal(await assertNeonRecoveryIdentity(client, role, BRANCH), expires);
    assert.deepEqual((await client.query(markerQuery)).rows, markerBefore);
    if (role === ROLES.migration) continue;
    const privileges = await client.query(`SELECT
      has_table_privilege(current_user, 'public.neon_recovery_acceptance', 'SELECT') AS readable,
      has_table_privilege(current_user, 'public.neon_recovery_acceptance',
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable`);
    assert.deepEqual(privileges.rows, [{ readable: true, writable: false }]);
  }

  const resetPool = heldClientPool(clients.get(ROLES.reset));
  const objects = new Map();
  let puts = 0;
  const storage = {
    async put(reference, bytes) {
      puts += 1;
      objects.set(reference.key, Buffer.from(bytes));
      return reference.key;
    },
    async get(reference) { return objects.get(reference.key); },
    async remove() { assert.fail('The recovery marker regression must not delete objects.'); },
  };
  const mediaObjects = createPostgresMediaObjectRepository(resetPool, { storage, includeDemoCatalogue: true });
  const repository = createPostgresDemoResetRepository({ pool: resetPool, mediaObjects,
    expectedDatabaseName: DATABASE, expectedResetRole: ROLES.reset });
  const resetInput = { fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM };
  const northwind = DEMO_FIXTURE.tenants[0];
  const changeRoom = (name) => clients.get(ROLES.customer).query(
    'UPDATE public.rooms SET name = $1 WHERE tenant_id = $2 AND id = $3',
    [name, northwind.id, northwind.settings.locations[0].rooms[0].id],
  );
  const readState = () => readDemoSemanticState({ client: migration, mediaObjects });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    if (cycle === 1) {
      assert.equal((await changeRoom('Changed before the second recovery reset')).rowCount, 1);
      const changedState = await readState();
      assert.throws(() => verifyRestoredSemanticState(changedState));
    }
    assert.deepEqual(await repository.reset(resetInput), {
      seedVersion: DEMO_FIXTURE.seedVersion, checksum: DEMO_FIXTURE_CHECKSUM,
    });
    const state = await readState();
    assert.equal(verifyRestoredSemanticState(state), semanticChecksum(state));
    assert.deepEqual(state.tenants.map(({ displayName }) => displayName).sort(),
      DEMO_FIXTURE.tenants.map(({ displayName }) => displayName).sort());
    assert.equal(semanticChecksum(state.customerPersonas), semanticChecksum(DEMO_FIXTURE.customerPersonas));
    assert.equal(objects.size, 34);
    assert.deepEqual((await inventory()).rows, tablesBefore);
    for (const role of Object.values(ROLES)) {
      assert.equal(await assertNeonRecoveryIdentity(clients.get(role), role, BRANCH), expires);
      assert.deepEqual((await clients.get(role).query(markerQuery)).rows, markerBefore);
    }
  }

  await assert.rejects(assertNeonRecoveryIdentity(migration, ROLES.migration, BRANCH, expires),
    /NEON_RECOVERY_MARKER_INVALID/);
  await pool.query(`ALTER VIEW public.neon_recovery_acceptance OWNER TO ${identifier(observer)}`);
  await assert.rejects(assertNeonRecoveryIdentity(clients.get(ROLES.reset), ROLES.reset, BRANCH),
    /NEON_RECOVERY_MARKER_INVALID/);
  await pool.query(`ALTER VIEW public.neon_recovery_acceptance OWNER TO ${identifier(ROLES.migration)}`);

  await migration.query('ALTER VIEW public.neon_recovery_acceptance RENAME TO retained_recovery_marker');
  await migration.query('CREATE TABLE public.neon_recovery_acceptance AS SELECT * FROM public.retained_recovery_marker');
  await migration.query(`GRANT SELECT ON public.neon_recovery_acceptance
    TO ${identifier(ROLES.customer)}, ${identifier(ROLES.platform)}, ${identifier(ROLES.reset)}`);
  assert.deepEqual((await migration.query(markerQuery)).rows, markerBefore);
  for (const role of Object.values(ROLES)) {
    await assert.rejects(assertNeonRecoveryIdentity(clients.get(role), role, BRANCH), /NEON_RECOVERY_MARKER_INVALID/);
  }
  assert.equal((await changeRoom('Preserve this change when an invalid marker blocks reset')).rowCount, 1);
  const beforeFailure = semanticChecksum(await readState());
  const writesBeforeFailure = puts;
  await assert.rejects(repository.reset(resetInput), { code: 'DEMO_RESET_SCHEMA_INVENTORY_INVALID' });
  assert.equal(semanticChecksum(await readState()), beforeFailure);
  assert.equal(puts, writesBeforeFailure);
  assert.deepEqual((await migration.query(markerQuery)).rows, markerBefore);
});
