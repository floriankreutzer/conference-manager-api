import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadTargetSetupConfig } from '../scripts/support/target-load-setup-config.mjs';
import { prepareTargetLoadSetup } from '../scripts/target-load-setup.mjs';
import { seedLoadSessions } from '../scripts/support/target-load-sessions.mjs';
import { seedBookingLoadFixtures } from '../scripts/support/target-load-fixtures.mjs';
import { targetLoadSetupEnvironment as setupEnv, NOW, RUN } from './support/target-load-environment.js';

test('installer config keeps privileged credentials local and binds fixed fixture population, origin and verified TLS', () => {
  const value = loadTargetSetupConfig(setupEnv(), NOW);
  assert.equal(value.config.databaseSsl, 'verify-full'); assert.equal(value.config.databasePoolMax, 2);
  assert.equal(value.config.host, '127.0.0.1'); assert.equal(value.config.port, 0); assert.equal(value.population, 100);
  assert.ok(Buffer.byteLength(value.config.oidcTransactionSecret) >= 32);
  assert.notEqual(value.config.oidcTransactionSecret, loadTargetSetupConfig(setupEnv(), NOW).config.oidcTransactionSecret);
  assert.equal(new URL(value.config.databaseUrl).search, '');
  assert.equal(value.scope.databaseUser, `saas38_load_${RUN}_setup`);
  assert.equal(value.origins.customer, `https://cm-saas38-load-${RUN}-customer.onrender.com`);
  assert.match(loadTargetSetupConfig({ ...setupEnv(), LOAD_STORAGE_CLUSTER: '7' }, NOW).storageConfig.endpoint,
    /\.storage\.c-7\.eu-central-1\.aws\.neon\.tech$/);
  assert.match(loadTargetSetupConfig({ ...setupEnv(), LOAD_STORAGE_CLUSTER: '8' }, NOW).storageConfig.endpoint,
    /\.storage\.c-8\.eu-central-1\.aws\.neon\.tech$/);
  for (const change of [{ RENDER: 'true' }, { LOAD_FIXTURE_USERS: '1e3' }, { LOAD_FIXTURE_USERS: '100000' },
    { LOAD_CSRF_SECRET: undefined }, { LOAD_SERVICE_NAME: 'conference-manager-demo' },
    { LOAD_STORAGE_PROBE_JSON: 'private-prior-manifest' }, { DATABASE_URL: 'private-existing-database' },
    { LOAD_STORAGE_CLUSTER: '0' }, { LOAD_STORAGE_CLUSTER: '7?query' }]) {
    assert.throws(() => loadTargetSetupConfig({ ...setupEnv(), ...change }, NOW), /^Error: LOAD_SETUP_CONFIG_INVALID$/);
  }
});

test('installer rejects guard failure, expired async result and existing marker before schema or fixture mutation', async () => {
  for (const fault of ['guard', 'expiry', 'existing']) {
    let now = NOW; let queries = 0; let closed = 0; let storageClosed = 0;
    await assert.rejects(prepareTargetLoadSetup({ env: setupEnv(), clock: () => now,
      storageFactory: () => ({ close() { storageClosed += 1; } }),
      persistenceFactory: () => ({ pool: { async query() { queries += 1; return { rows: [{ marker: 'saas38_load_scope' }] }; } },
        async close() { closed += 1; } }),
      async verifyDatabase() {
        if (fault === 'guard') throw new Error('private-connection-material');
        if (fault === 'expiry') now += 3_600_000;
      },
    }), /^Error: LOAD_TARGET_SETUP_FAILED$/);
    assert.equal(queries, fault === 'existing' ? 1 : 0); assert.equal(closed, 1); assert.equal(storageClosed, 1);
  }
});

test('fixed synthetic fixture bounds fail before SQL and never accept foreign roles or an unbounded population', async () => {
  const tenants = Array.from({ length: 10 }, () => randomUUID()); let queries = 0;
  const pool = { async query() { queries += 1; } };
  for (const target of [0, -1, 10_001, Infinity, '1000']) {
    await assert.rejects(seedLoadSessions(pool, tenants, [], target), /^Error: LOAD_SESSION_FIXTURES_FAILED$/);
  }
  await assert.rejects(seedLoadSessions(pool, tenants, [], 100, { roles: ['platform_admin'] }));
  await assert.rejects(seedLoadSessions(pool, [tenants[0], ...tenants.slice(0, 9)], [], 100));
  await assert.rejects(seedBookingLoadFixtures(pool, tenants, { population: 200 }));
  assert.equal(queries, 0);
});

test('shared fixture issuance keeps plaintext cookies outside bounded persisted session records', async () => {
  const tenants = Array.from({ length: 10 }, () => randomUUID()); const fixtures = []; const persisted = [];
  await seedLoadSessions({ async query(_sql, values) { persisted.push(values[0]); } }, tenants, fixtures, 1000,
    { roles: ['employee'], publicOrigin: 'https://synthetic.invalid', sessionTtlSeconds: 600 });
  assert.equal(fixtures.length, 1000); assert.equal(new Set(fixtures.map(row => row.userId)).size, 1000);
  assert.equal(persisted.length, 4); assert.ok(persisted.every(chunk => JSON.parse(chunk).length === 500));
  assert.ok(fixtures.every(row => /^cm_session=[A-Za-z0-9_-]{43}$/.test(row.cookie)));
  assert.equal(fixtures.some(row => persisted.some(chunk => chunk.includes(row.cookie.slice(11)))), false);
  assert.equal(persisted.some(chunk => chunk.includes('"cookie"')), false);
});

test('installer CLI rejects unknown authority without writing a private manifest or revealing input', () => {
  const result = spawnSync(process.execPath, ['scripts/target-load-setup.mjs'], { env: { ...process.env,
    LOAD_RUN_ID: 'invalid', LOAD_DATABASE_URL: 'private-existing-material' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'LOAD_TARGET_SETUP_FAILED\n');
});
