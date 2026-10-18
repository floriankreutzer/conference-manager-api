import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { startTargetLoadRuntime } from '../scripts/target-load-runtime.mjs';
import { assertLoadDatabase } from '../scripts/support/target-load-guard.mjs';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { createPostgresPlatformPersistence } from '../src/persistence/postgres/platform-index.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createPlatformComposition } from '../src/platform-composition.js';
import { targetLoopbackJson, targetLoopbackResponse } from '../tests/support/target-load-http.js';
import { targetLoadEnvironment, RUN } from '../tests/support/target-load-environment.js';
import { createBookingJourneyFixture } from './support/booking-journey-fixture.js';

function identifier(value) { assert.match(value, /^[a-z][a-z0-9_]*$/); return `"${value}"`; }

test('target compositions run real PostgreSQL with separate restricted roles and canonical HTTP/worker services', async t => {
  const fixtureCleanup = []; const runtimes = []; const roles = [];
  const fixture = await createBookingJourneyFixture({ after: cleanup => fixtureCleanup.push(cleanup) });
  const pool = fixture.persistence.pool;
  t.after(async () => {
    try {
      for (const runtime of runtimes.reverse()) await runtime.stop();
      for (const role of roles.reverse()) {
        await pool.query(`DROP OWNED BY ${identifier(role)}`); await pool.query(`DROP ROLE ${identifier(role)}`);
      }
    } finally { for (const cleanup of fixtureCleanup) await cleanup(); }
  });
  const runId = randomBytes(8).toString('hex'); const created = Date.now() - 1000; const expires = created + 120_000;
  const customer = `saas38_load_${runId}_customer`; const platform = `saas38_load_${runId}_platform`;
  for (const role of [customer, platform]) {
    await pool.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    roles.push(role); await pool.query(`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
  }
  await pool.query(`CREATE TABLE public.saas38_load_scope
    (run_id text,release_sha text,created_at timestamptz,expires_at timestamptz)`);
  await pool.query('INSERT INTO public.saas38_load_scope VALUES($1,$2,$3,$4)',
    [runId, 'a'.repeat(40), new Date(created), new Date(expires)]);
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  for (const { tablename } of tables.rows) {
    if (tablename.startsWith('platform_') || ['saas38_load_scope', 'schema_migrations',
      'media_object_inventory', 'tenant_room_media_assets'].includes(tablename)) continue;
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${identifier(tablename)} TO ${identifier(customer)}`);
  }
  await pool.query(`GRANT SELECT,INSERT ON public.media_object_inventory,public.tenant_room_media_assets TO ${identifier(customer)}`);
  await pool.query(`GRANT UPDATE(object_key) ON public.media_object_inventory TO ${identifier(customer)}`);
  const sequences = await pool.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public'"
    + " AND sequencename NOT LIKE 'platform_%'");
  for (const { sequencename } of sequences.rows) {
    await pool.query(`GRANT USAGE ON SEQUENCE public.${identifier(sequencename)} TO ${identifier(customer)}`);
  }
  for (const table of ['schema_migrations', 'saas38_load_scope']) {
    await pool.query(`GRANT SELECT ON public.${identifier(table)} TO ${identifier(customer)},${identifier(platform)}`);
  }
  for (const table of ['tenants', 'tenant_identity_bindings', 'tenant_onboarding_invitations', 'integrations',
    'tenant_entitlements', 'microsoft365_room_mappings', 'microsoft365_capability_health', 'platform_sessions', 'platform_operators']) {
    await pool.query(`GRANT SELECT ON public.${identifier(table)} TO ${identifier(platform)}`);
  }
  await pool.query(`GRANT UPDATE(id) ON public.tenants TO ${identifier(platform)}`);
  for (const table of ['platform_projection_outbox', 'platform_tenant_readiness_snapshots',
    'platform_microsoft_fleet_snapshots', 'platform_microsoft_fleet_capabilities']) {
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${identifier(table)} TO ${identifier(platform)}`);
  }
  await pool.query(`GRANT SELECT,INSERT ON public.platform_audit_events,public.platform_audit_checkpoints TO ${identifier(platform)}`);
  await pool.query(`GRANT SELECT,UPDATE ON public.platform_audit_chain_state TO ${identifier(platform)}`);
  const originalUrl = new URL(process.env.DATABASE_URL); const servers = {}; const environments = {}; const scoped = {};
  const localConfig = (config, role) => {
    const url = new URL(originalUrl); url.username = role; url.password = '';
    return { ...config, mode: 'test', databaseUrl: url.toString(), databaseSsl: 'disable' };
  };
  for (const surface of ['customer', 'platform']) {
    const env = JSON.parse(JSON.stringify(targetLoadEnvironment(surface)).replaceAll(RUN, runId));
    env.LOAD_CREATED_AT = new Date(created).toISOString(); env.LOAD_EXPIRES_AT = new Date(expires).toISOString();
    if (surface === 'customer') {
      env.LOAD_AUDIT_HMAC_SECRET = fixture.config.auditHmacSecret;
      env.LOAD_CSRF_SECRET = fixture.config.csrfSecret;
      env.LOAD_STORAGE_PROBE_JSON = JSON.stringify({ tenantId: fixture.tenants[0], ...fixture.images[0] });
    } else env.LOAD_TENANT_AUDIT_HMAC_SECRET = fixture.config.auditHmacSecret;
    environments[surface] = env;
    const starting = startTargetLoadRuntime({ env,
      customerPersistence(config, options) {
        scoped.customer = createPostgresPersistence(localConfig(config, customer), options); return scoped.customer;
      },
      platformPersistence(config) {
        scoped.platform = createPostgresPlatformPersistence(localConfig(config, platform)); return scoped.platform;
      },
      storageFactory: () => ({ ...fixture.storage, close() {} }),
      // The runner's disposable loopback database deliberately has its own name
      // and plaintext transport. Preserve the real role/rights/marker SQL guard;
      // pure configuration tests separately reject remote name/TLS substitution.
      verifyDatabase: (database, scope, options) => assertLoadDatabase(database,
        { ...scope, databaseName: originalUrl.pathname.slice(1) }, options),
      customerComposition(options) {
        const result = createCustomerComposition({ ...options, config: { ...options.config, host: '127.0.0.1', port: 0 } });
        servers.customer = result.server; return result;
      },
      platformComposition(options) {
        const result = createPlatformComposition({ ...options, config: { ...options.config, host: '127.0.0.1', port: 0 } });
        servers.platform = result.process.server; return result;
      },
    });
    let runtime;
    try { runtime = await starting; } catch (error) {
      t.diagnostic(JSON.stringify({ surface, phase: error.phase })); throw error;
    }
    runtimes.push(runtime);
  }
  const employee = fixture.employees[0]; const customerHost = new URL(environments.customer.LOAD_PUBLIC_ORIGIN).host;
  const session = await targetLoopbackJson(servers.customer, '/api/v1/session', customerHost, { Cookie: employee.cookie });
  assert.equal(session.status, 200); const identity = session.body;
  assert.equal(identity.user.id, employee.userId); assert.equal(identity.tenant.id, employee.tenantId);
  const path = `/api/v1/tenant/rooms/room/media/${fixture.images[0].assetId}`;
  const before = fixture.objectCounters().reads;
  for (const cookie of [undefined, fixture.employees[1].cookie]) {
    const denied = await targetLoopbackJson(servers.customer, path, customerHost, cookie ? { Cookie: cookie } : {});
    assert.equal(denied.status, cookie ? 404 : 401);
  }
  assert.equal(fixture.objectCounters().reads, before);
  const image = await targetLoopbackResponse(servers.customer, path, customerHost,
    { headers: { Cookie: employee.cookie }, maxBytes: 2 * 1024 * 1024 });
  assert.equal(image.status, 200);
  assert.equal(createHash('sha256').update(image.body).digest('hex'), fixture.images[0].sha256);
  for (const surface of ['customer', 'platform']) {
    const response = await targetLoopbackJson(servers[surface], '/__load/observe',
      new URL(environments[surface].LOAD_PUBLIC_ORIGIN).host,
      { Authorization: `Bearer ${environments[surface].LOAD_OBSERVER_TOKEN}` });
    assert.equal(response.status, 200); const facts = response.body;
    assert.equal(facts.activity.workerFailures, 0); assert.equal(facts.surface, surface);
    assert.ok(facts.postgres.queries > 0 && facts.postgres.bytesRead > 0 && facts.postgres.bytesWritten > 0);
    if (surface === 'platform') assert.ok(facts.metricTotals.platform_projection_batches_total > 0);
    else {
      assert.equal(facts.activity.storageReads, 2);
      assert.equal(facts.activity.storageReadBytes, 2 * fixture.images[0].byteLength);
    }
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_tenant_readiness_snapshots')).rows[0].count, 10);
  await assert.rejects(scoped.customer.pool.query('SELECT * FROM public.platform_audit_events'), error => error.code === '42501');
  await assert.rejects(scoped.platform.pool.query('SELECT * FROM public.requests'), error => error.code === '42501');
  for (const surface of ['customer', 'platform']) {
    await assert.rejects(scoped[surface].pool.query("UPDATE public.saas38_load_scope SET release_sha='invalid'"),
      error => error.code === '42501');
  }
  const deniedCsrf = await targetLoopbackResponse(servers.customer, '/api/v1/application/room-availability', customerHost,
    { method: 'POST',
    headers: { Cookie: employee.cookie, Origin: environments.customer.LOAD_PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
    body: '{}' });
  assert.equal(deniedCsrf.status, 403);
  const host = new URL(environments.platform.LOAD_PUBLIC_ORIGIN).host;
  const deniedCustomer = await targetLoopbackJson(servers.platform, '/api/v1/platform/session', host, { Cookie: employee.cookie });
  assert.equal(deniedCustomer.status, 401);
  const deniedAudit = await pool.query(`SELECT action,outcome,operator_id,target_tenant_id,metadata
    FROM public.platform_audit_events ORDER BY sequence`);
  assert.equal(deniedAudit.rowCount, 1);
  assert.equal(deniedAudit.rows[0].action, 'platform.authentication.failed');
  assert.equal(deniedAudit.rows[0].outcome, 'failure');
  assert.equal(deniedAudit.rows[0].operator_id, null); assert.equal(deniedAudit.rows[0].target_tenant_id, null);
  assert.equal(deniedAudit.rows[0].metadata.reasonCode, 'customer_session_rejected');
  const login = await targetLoopbackJson(servers.platform, '/api/v1/platform/auth/microsoft/login', host);
  assert.equal(login.status, 503); assert.equal(login.body.error.code, 'PLATFORM_IDENTITY_UNAVAILABLE');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_oidc_auth_transactions')).rows[0].count, 0);
});
