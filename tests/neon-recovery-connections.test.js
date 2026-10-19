import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runNeonRecoveryConnections, safeConnectionCode, CONNECTION_REPORT } from '../scripts/support/neon-recovery-connections.mjs';
import { loadNeonRecoveryDatabaseConfig, RECOVERY_ROLES, RECOVERY_ROOT,
  RECOVERY_SNAPSHOT, RECOVERY_MANIFEST } from '../scripts/support/neon-recovery-config.mjs';

const host = 'ep-recovery-test.c-5.eu-central-1.aws.neon.tech';
const branch = 'br-disposable-connections';
const provisioned = Date.parse('2026-10-11T19:00:00Z');
const now = provisioned + 60_000;
function environment() {
  return { NODE_ENV: 'test', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_REPOSITORY: 'floriankreutzer/conference-manager-api', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch',
    NEON_RECOVERY_BRANCH: branch, NEON_RECOVERY_HOST: host, DEMO_DATABASE_SSL: 'verify-full',
    NEON_RECOVERY_CONNECTION_PHASE: 'before-marker', NEON_RECOVERY_PROVISIONED_AT: '2026-10-11T19:00:00Z',
    ...Object.fromEntries(Object.entries(RECOVERY_ROLES).map(([key, role], index) =>
      [key, `postgresql://${role}:synthetic-password-${index}@${host}/conference_manager_demo_shared`])) };
}

function fixture({ env = environment(), connectError, closeError, queryHook, closeHook, clock } = {}) {
  const clients = [];
  const settings = [];
  const marker = { branch_id: branch, source_branch_id: RECOVERY_ROOT, snapshot_id: RECOVERY_SNAPSHOT,
    object_manifest_sha256: RECOVERY_MANIFEST, created_at: new Date(provisioned + 30_000),
    expires_at: new Date(provisioned + 60 * 60_000) };
  const execute = () => runNeonRecoveryConnections({ env, wallNow: () => clock?.wall ?? now,
    monotonicNow: () => clock?.monotonic ?? 0, clientFactory(options) {
      settings.push(options);
      const role = new URL(options.connectionString).username;
      const client = new EventEmitter();
      client.queries = [];
      client.closed = false;
      client.connect = async () => { if (connectError) throw connectError; };
      client.end = async () => { client.closed = true; if (closeError) throw closeError; await closeHook?.(client); };
      client.query = async (sql) => {
        client.queries.push(sql);
        const overridden = await queryHook?.({ sql, role, client, clients, marker });
        if (overridden !== undefined) return overridden;
        if (sql.startsWith('SELECT session_user')) return { rows: [{ login: role, role,
          database: 'conference_manager_demo_shared', read_only: 'on', observed_at: new Date(clock?.wall ?? now) }] };
        if (sql.startsWith('SELECT current_user')) return { rows: [{ role, database: 'conference_manager_demo_shared' }] };
        if (sql.includes('max(version)')) return { rows: [{ runtime: 50, overlay: 16 }] };
        if (sql.includes('to_regclass')) return { rows: [{ marker: null }] };
        if (sql.includes('pg_catalog.pg_class')) return { rows: [{ kind: 'v', owner: 'cm_demo_migration' }] };
        if (sql.includes('FROM public.neon_recovery_acceptance')) return { rows: [{ ...marker }] };
        return { rows: [] };
      };
      clients.push(client);
      return client;
    } });
  return { execute, clients, settings, marker, env };
}

test('four actual clients use verified TLS, bounded timeouts and fixed read-only statements without storage config', async () => {
  const f = fixture();
  const report = await f.execute();
  assert.equal(report.outcome, 'passed');
  assert.deepEqual(report.completedRoles, Object.values(RECOVERY_ROLES));
  assert.equal(f.clients.length, 4);
  assert.equal(loadNeonRecoveryDatabaseConfig(f.env).databases.length, 4);
  for (const options of f.settings) {
    assert.deepEqual(options.ssl, { rejectUnauthorized: true });
    assert.equal(options.options, '-c default_transaction_read_only=on');
    for (const key of ['connectionTimeoutMillis', 'statement_timeout', 'query_timeout', 'idle_in_transaction_session_timeout']) {
      assert.equal(options[key], 5000);
    }
  }
  for (const client of f.clients) {
    assert.equal(client.closed, true);
    assert.equal(client.queries[0], 'BEGIN READ ONLY');
    assert.equal(client.queries.at(-2), 'ROLLBACK');
    assert.ok(client.queries.every((sql) => /^(SELECT |BEGIN READ ONLY$|ROLLBACK$)/.test(sql)));
    assert.ok(client.queries.every((sql) => !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|SET ROLE)\b/.test(sql)));
  }
  assert.doesNotMatch(JSON.stringify(report), /postgres|synthetic-password|connectionString|storage|stack/);
});

test('DNS, TLS, authentication and permission failures stop on the first role and retain exact safe stage/code', async (t) => {
  for (const code of ['EAI_AGAIN', 'ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID', '28P01', '42501']) {
    await t.test(code, async () => {
      const f = fixture({ connectError: Object.assign(new Error('private raw error'), { code }) });
      const report = await f.execute();
      assert.equal(report.failedStage, 'connect');
      assert.equal(report.code, code);
      assert.equal(report.outcome, 'failed');
      assert.deepEqual(report.completedRoles, []);
      assert.equal(f.clients.length, 1);
      assert.equal(f.clients[0].closed, true);
      assert.doesNotMatch(JSON.stringify(report), /private raw error/);
    });
  }
});

test('schema failure survives a separate cleanup error; cleanup-only failure is never counted as success', async () => {
  const closeError = Object.assign(new Error('hidden'), { code: 'ECONNRESET' });
  const f = fixture({ closeError, queryHook: ({ sql }) => sql.includes('max(version)')
    ? { rows: [{ runtime: 43, overlay: 11 }] } : undefined });
  const report = await f.execute();
  assert.equal(report.failedStage, 'schema');
  assert.equal(report.code, 'NEON_RECOVERY_SCHEMA_INVALID');
  assert.deepEqual(report.cleanupErrors, [{ role: 'cm_demo_customer', stage: 'close', code: 'ECONNRESET' }]);
  const close = await fixture({ closeError }).execute();
  assert.equal(close.failedStage, 'close');
  assert.deepEqual(close.completedRoles, []);
});

test('configuration rejects unsafe binding, replay, roles, transport overrides and invalid times before allocation', async () => {
  const invalid = [
    { GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_SHA: 'bad' }, { NODE_ENV: 'production' },
    { NEON_RECOVERY_CONNECTION_PHASE: 'retry' }, { NEON_RECOVERY_PROVISIONED_AT: '2026-10-11T19:02:00Z' },
    { NEON_RECOVERY_PROVISIONED_AT: '2026-10-11T18:31:00Z' }, { NEON_RECOVERY_PROVISIONED_AT: '2026-10-11 19:00:00Z' },
    { NEON_RECOVERY_BRANCH: RECOVERY_ROOT }, { NEON_RECOVERY_BRANCH: 'br-red-salad-b16r1iz9' },
    { NEON_RECOVERY_BRANCH: 'br-gentle-rice-b1w0yhm4' }, { NEON_RECOVERY_HOST: 'attacker.invalid' },
    { NEON_RECOVERY_HOST: 'ep-damp-wind-b1c04z8g.c-5.eu-central-1.aws.neon.tech' },
    { DEMO_DATABASE_SSL: 'disable' }, { DEMO_RESET_DATABASE_URL: undefined },
    { PGOPTIONS: '' }, { PGSSLNEGOTIATION: 'direct' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ];
  const original = environment().DEMO_CUSTOMER_DATABASE_URL;
  for (const url of [original + '?sslmode=disable', original + '#fragment', original.replace(host, '127.0.0.1'),
    original.replace('cm_demo_customer', 'cm_demo_migration'), original.replace('/conference_manager_demo_shared', '/postgres')]) {
    invalid.push({ DEMO_CUSTOMER_DATABASE_URL: url });
  }
  invalid.push({ DEMO_RESET_DATABASE_URL: environment().DEMO_RESET_DATABASE_URL.replace('synthetic-password-2',
    'synthetic-password-%30') });
  for (const change of invalid) {
    const f = fixture({ env: { ...environment(), ...change } });
    const report = await f.execute();
    assert.equal(report.outcome, 'failed');
    assert.equal(report.failedStage, 'configuration');
    assert.equal(f.clients.length, 0);
  }
});

test('read-only state, session identity, marker absence and database clock are checked', async () => {
  for (const change of [{ read_only: 'off' }, { login: 'cm_demo_migration' }, { database: 'postgres' },
    { observed_at: new Date(provisioned - 1) }, { observed_at: new Date(provisioned + 30 * 60_000) }]) {
    const f = fixture({ queryHook: ({ sql, role }) => sql.startsWith('SELECT session_user')
      ? { rows: [{ login: role, role, database: 'conference_manager_demo_shared', read_only: 'on',
        observed_at: new Date(now), ...change }] } : undefined });
    assert.equal((await f.execute()).failedStage, 'identity');
    assert.equal(f.clients.length, 1);
  }
  const present = fixture({ queryHook: ({ sql }) => sql.includes('to_regclass') ? { rows: [{ marker: 'existing' }] } : undefined });
  assert.equal((await present.execute()).code, 'NEON_RECOVERY_MARKER_INVALID');
});

test('marker readback reuses the identity guard and requires the same fixed valid tuple for all four logins', async () => {
  const env = { ...environment(), NEON_RECOVERY_CONNECTION_PHASE: 'marker-readback' };
  const f = fixture({ env });
  const report = await f.execute();
  assert.equal(report.outcome, 'passed');
  assert.equal(report.markerCreatedAt, f.marker.created_at.toISOString());
  assert.equal(report.markerExpiresAt, f.marker.expires_at.toISOString());
  for (const change of [{ created_at: new Date(provisioned - 1) }, { created_at: new Date(now + 1) },
    { expires_at: new Date(provisioned + 90 * 60_000 + 1) }, { branch_id: RECOVERY_ROOT }]) {
    const bad = fixture({ env });
    Object.assign(bad.marker, change);
    assert.equal((await bad.execute()).code, 'NEON_RECOVERY_MARKER_INVALID');
  }
  const changed = fixture({ env, queryHook: ({ sql, clients, marker }) =>
    clients.length === 2 && sql.includes('FROM public.neon_recovery_acceptance')
      ? { rows: [{ ...marker, created_at: new Date(provisioned + 31_000) }] } : undefined });
  assert.equal((await changed.execute()).code, 'NEON_RECOVERY_MARKER_INVALID');
  assert.equal(changed.clients.length, 2);
});

test('wall and monotonic deadlines stop before the next operation and close the current client', async () => {
  for (const mutation of [(clock) => { clock.wall = provisioned + 30 * 60_000; },
    (clock) => { clock.monotonic = 60_000; }]) {
    const clock = { wall: now, monotonic: 0 };
    const f = fixture({ clock, queryHook: ({ sql }) => { if (sql === 'BEGIN READ ONLY') mutation(clock); } });
    const report = await f.execute();
    assert.equal(report.code, 'NEON_RECOVERY_DEADLINE');
    assert.equal(f.clients.length, 1);
    assert.equal(f.clients[0].closed, true);
    assert.deepEqual(f.clients[0].queries, ['BEGIN READ ONLY']);
  }
});

test('malicious errors never invoke getters or serialization and unknown details stay out of reports', async () => {
  const malicious = Object.defineProperties({}, {
    code: { get() { throw new Error('getter invoked'); } }, message: { get() { throw new Error('getter invoked'); } },
    toJSON: { value() { throw new Error('serialization invoked'); } },
  });
  assert.equal(safeConnectionCode(malicious), 'UNKNOWN');
  assert.equal(safeConnectionCode(Object.create({ code: '28P01' })), 'UNKNOWN');
  for (const error of [malicious, 'postgres://secret', new Error('postgres://secret'), null, undefined]) {
    assert.equal(safeConnectionCode(error), 'UNKNOWN');
  }
  const report = await fixture({ connectError: malicious }).execute();
  assert.equal(report.code, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(report), /getter|serialization|postgres:\/\//);
});

test('entrypoint retains only safe JSON with 0600 permissions and refuses evidence overwrite', async () => {
  const directory = await mkdtemp(`${tmpdir()}/neon-connections-`);
  try {
    const command = resolve('scripts/neon-recovery-connections.mjs');
    const run = () => spawnSync(process.execPath, [command], { cwd: directory,
      env: { ...process.env, ...environment(), GITHUB_REF: 'refs/heads/invalid',
        NEON_RECOVERY_PROVISIONED_AT: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z') },
      encoding: 'utf8', timeout: 5000 });
    const first = run();
    assert.equal(first.status, 1);
    assert.equal(first.stdout, '');
    assert.equal(first.stderr, 'NEON_RECOVERY_CONNECTIONS_FAILED\n');
    const path = resolve(directory, CONNECTION_REPORT);
    const content = await readFile(path, 'utf8');
    assert.equal(JSON.parse(content).failedStage, 'configuration');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(run().stderr, 'NEON_RECOVERY_CONNECTIONS_REPORT_FAILED\n');
    assert.equal(await readFile(path, 'utf8'), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bounded query/close failures and asynchronous close errors cannot pass or allocate another client', async () => {
  const hungQuery = fixture({ queryHook: ({ sql }) => sql === 'BEGIN READ ONLY' ? new Promise(() => {}) : undefined });
  const query = await hungQuery.execute();
  assert.equal(query.code, 'NEON_RECOVERY_OPERATION_TIMEOUT');
  assert.equal(query.failedStage, 'begin');
  assert.equal(hungQuery.clients.length, 1);
  const hungClose = fixture({ closeHook: () => new Promise(() => {}) });
  const close = await hungClose.execute();
  assert.equal(close.code, 'NEON_RECOVERY_CLOSE_TIMEOUT');
  assert.deepEqual(close.completedRoles, []);
  const asynchronous = fixture({ closeHook: (client) => client.emit('error', Object.assign(new Error('hidden'), { code: 'EPIPE' })) });
  const emitted = await asynchronous.execute();
  assert.equal(emitted.failedStage, 'close');
  assert.equal(emitted.code, 'EPIPE');
  assert.deepEqual(emitted.cleanupErrors, [{ role: 'cm_demo_customer', stage: 'close', code: 'EPIPE' }]);
  assert.equal(asynchronous.clients.length, 1);
  assert.deepEqual(emitted.completedRoles, []);
  assert.equal(safeConnectionCode(new Error('timeout expired')), 'PG_CONNECTION_TIMEOUT');
  assert.equal(safeConnectionCode(new Error('Query read timeout')), 'PG_QUERY_TIMEOUT');
  assert.equal(safeConnectionCode(new Error('Query read timeout secret')), 'UNKNOWN');
});
