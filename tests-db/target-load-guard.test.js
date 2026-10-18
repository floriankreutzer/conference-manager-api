import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { assertLoadDatabase } from '../scripts/support/target-load-guard.mjs';

// SQL-contract evidence only: the integration runner's disposable loopback database
// deliberately does not satisfy the independent remote configuration/control-plane guards.
test('target SQL guard verifies actual PostgreSQL identity, privileges, membership and marker', async (t) => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  const admin = new Client({ connectionString: url.toString(), statement_timeout: 5000 });
  const scoped = new Client({ connectionString: url.toString(), statement_timeout: 5000 });
  const runId = randomBytes(8).toString('hex');
  const role = `saas38_guard_${runId}`;
  const inherited = `${role}_member`;
  const createdRoles = [];
  await admin.connect();
  t.after(async () => {
    await scoped.end();
    try {
      for (const name of createdRoles.reverse()) {
        await admin.query(`DROP OWNED BY "${name}"`);
        await admin.query(`DROP ROLE "${name}"`);
      }
    } finally { await admin.end(); }
  });
  for (const name of [role, inherited]) {
    await admin.query(`CREATE ROLE "${name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(name);
  }
  await scoped.connect();
  await scoped.query(`SET ROLE "${role}"`);
  const now = Date.now();
  const scope = Object.freeze({ surface: 'setup', runId, releaseSha: 'a'.repeat(40),
    databaseName: url.pathname.slice(1), databaseUser: role,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), expiresMs: now + 60000 });
  const verify = (client = scoped, value = scope, options = {}) =>
    assertLoadDatabase(client, value, { clock: () => now, ...options });
  await verify(scoped, scope, { allowEmpty: true });
  await assert.rejects(verify(), /^Error: LOAD_TARGET_SCOPE_INVALID$/);
  await assert.rejects(verify(scoped, { ...scope, surface: 'customer' }, { allowEmpty: true }));
  await admin.query('CREATE VIEW public.unexpected_load_view AS SELECT 1 AS value');
  await assert.rejects(verify(scoped, scope, { allowEmpty: true }));
  await admin.query('DROP VIEW public.unexpected_load_view');
  await admin.query("CREATE TYPE public.unexpected_load_type AS ENUM ('unexpected')");
  await assert.rejects(verify(scoped, scope, { allowEmpty: true }));
  await admin.query('DROP TYPE public.unexpected_load_type');
  await admin.query(`CREATE TABLE public.saas38_load_scope
    (run_id text NOT NULL,release_sha text NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL)`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await admin.query(`GRANT SELECT ON public.saas38_load_scope TO "${role}"`);
  const marker = [runId, scope.releaseSha, scope.createdAt, scope.expiresAt];
  await admin.query('INSERT INTO public.saas38_load_scope VALUES($1,$2,$3,$4)', marker);
  await verify();
  const adminIdentity = await admin.query('SELECT current_user AS actor');
  await assert.rejects(verify(admin, { ...scope, databaseUser: adminIdentity.rows[0].actor }));
  await assert.rejects(verify(scoped, { ...scope, databaseName: 'wrong_database' }));
  await admin.query(`GRANT "${inherited}" TO "${role}"`);
  await assert.rejects(verify(), /^Error: LOAD_TARGET_SCOPE_INVALID$/);
  await admin.query(`REVOKE "${inherited}" FROM "${role}"`);
  await verify();
  await admin.query('CREATE SCHEMA guard_shadow');
  await admin.query('CREATE TABLE guard_shadow.saas38_load_scope (LIKE public.saas38_load_scope)');
  await admin.query(`GRANT USAGE ON SCHEMA guard_shadow TO "${role}"`);
  await admin.query(`GRANT SELECT ON guard_shadow.saas38_load_scope TO "${role}"`);
  await scoped.query('SET search_path TO guard_shadow, public');
  await verify(); // An empty same-named shadow must not replace the verified public marker.
  await admin.query("UPDATE public.saas38_load_scope SET release_sha=repeat('b',40)");
  await assert.rejects(verify(), /^Error: LOAD_TARGET_SCOPE_INVALID$/);
  await admin.query('UPDATE public.saas38_load_scope SET release_sha=$1', [scope.releaseSha]);
  await admin.query('INSERT INTO public.saas38_load_scope VALUES($1,$2,$3,$4)', marker);
  await assert.rejects(verify(), /^Error: LOAD_TARGET_SCOPE_INVALID$/);
});
