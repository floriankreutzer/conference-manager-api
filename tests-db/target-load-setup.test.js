import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { prepareTargetLoadSetup } from '../scripts/target-load-setup.mjs';
import { startTargetLoadRuntime } from '../scripts/target-load-runtime.mjs';
import { assertLoadDatabase, loadTargetScope } from '../scripts/support/target-load-guard.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { growTargetLoadPopulation } from '../scripts/support/target-load-growth.mjs';
import { mediaObjectReference, verifyMediaObjectBytes } from '../src/media/object-storage-contract.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { createPostgresPlatformPersistence } from '../src/persistence/postgres/platform-index.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createPlatformComposition } from '../src/platform-composition.js';
import { runBookingLoadJourney } from '../scripts/support/booking-load-journey.mjs';
import { requestLoadDraft } from '../tests/support/request-load-draft.js';
import { targetLoadEnvironment, targetLoadSetupEnvironment } from '../tests/support/target-load-environment.js';
import { targetLoopbackResponse, targetLoopbackJson } from '../tests/support/target-load-http.js';

function identifier(value) { assert.match(value, /^[a-z][a-z0-9_]*$/); return `"${value}"`; }

test('installer owns a fresh database, grants restricted runtime custody and supports a complete real-role booking', async t => {
  const original = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(original.hostname));
  assert.match(original.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  const runId = randomBytes(8).toString('hex'); const database = `saas38_load_${runId}`;
  const roles = ['setup', 'customer', 'platform'].map(surface => `saas38_load_${runId}_${surface}`);
  const admin = new Client({ connectionString: original.toString(), statement_timeout: 5000 });
  const createdRoles = []; const runtimes = []; const readers = []; let created = false;
  await admin.connect();
  t.after(async () => {
    try {
      for (const runtime of runtimes.reverse()) await runtime.stop();
      for (const reader of readers) await reader.end();
      if (created) await admin.query(`DROP DATABASE ${identifier(database)} WITH (FORCE)`);
      for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE ${identifier(role)}`);
    } finally { await admin.end(); }
  });
  for (const role of roles) {
    await admin.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(roles[0])}`); created = true;
  const localUrl = surface => {
    const url = new URL(original); url.pathname = `/${database}`; url.username = `saas38_load_${runId}_${surface}`;
    url.password = ''; return url.toString();
  };
  const localConfig = (config, surface) => ({ ...config, mode: 'test', databaseSsl: 'disable', databaseUrl: localUrl(surface) });
  const objects = new Map();
  const storageFactory = () => {
    let closed = false;
    return {
      async put(input, bytes) {
        assert.equal(closed, false); const reference = mediaObjectReference(input); verifyMediaObjectBytes(bytes, reference);
        assert.ok(objects.size < 10); objects.set(reference.key, Buffer.from(bytes)); return reference.key;
      },
      async get(input) {
        assert.equal(closed, false); const reference = mediaObjectReference(input);
        return verifyMediaObjectBytes(objects.get(reference.key), reference);
      },
      async remove() { throw new Error('UNEXPECTED_FIXTURE_DELETE'); },
      close() { closed = true; },
    };
  };
  const env = targetLoadSetupEnvironment(runId, Date.now());
  // The real installer/name/role/privilege SQL is preserved. Only the connection
  // transport is replaced with the runner's guarded disposable loopback database.
  const manifest = await prepareTargetLoadSetup({ env, storageFactory,
    persistenceFactory: (config, options) => createPostgresPersistence(localConfig(config, 'setup'), options) });
  assert.equal(manifest.employees.length, 100); assert.equal(manifest.managers.length, 10); assert.equal(objects.size, 10);
  const reader = new Pool({ connectionString: localUrl('setup'), max: 2, statement_timeout: 5000 }); readers.push(reader);
  const counts = await reader.query(`SELECT (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM rooms) AS rooms,(SELECT count(*)::int FROM requests) AS requests,
    (SELECT count(*)::int FROM tenant_room_media_assets WHERE bytes IS NULL AND object_key IS NOT NULL) AS media`);
  assert.deepEqual(counts.rows, [{ users: 110, rooms: 100, requests: 0, media: 10 }]);
  await assert.rejects(prepareTargetLoadSetup({ env, storageFactory,
    persistenceFactory: (config, options) => createPostgresPersistence(localConfig(config, 'setup'), options) }),
  /^Error: LOAD_TARGET_SETUP_FAILED$/);
  const servers = {}; const scoped = {}; const environments = {};
  for (const surface of ['customer', 'platform']) {
    const value = targetLoadEnvironment(surface, runId);
    value.LOAD_CREATED_AT = env.LOAD_CREATED_AT; value.LOAD_EXPIRES_AT = env.LOAD_EXPIRES_AT;
    if (surface === 'customer') {
      value.LOAD_AUDIT_HMAC_SECRET = env.LOAD_AUDIT_HMAC_SECRET; value.LOAD_CSRF_SECRET = env.LOAD_CSRF_SECRET;
      value.LOAD_STORAGE_PROBE_JSON = JSON.stringify(manifest.storageProbe);
    } else value.LOAD_TENANT_AUDIT_HMAC_SECRET = env.LOAD_AUDIT_HMAC_SECRET;
    environments[surface] = value;
    const runtime = await startTargetLoadRuntime({ env: value, storageFactory,
      customerPersistence(config, options) {
        scoped.customer = createPostgresPersistence(localConfig(config, 'customer'), options); return scoped.customer;
      },
      platformPersistence(config) {
        scoped.platform = createPostgresPlatformPersistence(localConfig(config, 'platform')); return scoped.platform;
      },
      customerComposition(options) {
        const result = createCustomerComposition({ ...options, config: { ...options.config, host: '127.0.0.1', port: 0 } });
        servers.customer = result.server; return result;
      },
      platformComposition(options) {
        const result = createPlatformComposition({ ...options, config: { ...options.config, host: '127.0.0.1', port: 0 } });
        servers.platform = result.process.server; return result;
      },
    });
    runtimes.push(runtime);
    await assertLoadDatabase(scoped[surface].pool, loadTargetScope(targetScopeValues(value)));
    await assert.rejects(scoped[surface].pool.query('CREATE TABLE public.unexpected_load_table(id int)'), error => error.code === '42501');
    await assert.rejects(scoped[surface].pool.query("UPDATE public.saas38_load_scope SET release_sha='invalid'"),
      error => error.code === '42501');
    await assert.rejects(scoped[surface].pool.query('SELECT * FROM public.platform_diagnostic_events'), error => error.code === '42501');
    await assert.rejects(scoped[surface].pool.query('DELETE FROM public.platform_diagnostic_events'), error => error.code === '42501');
  }
  const publicOrigin = environments.customer.LOAD_PUBLIC_ORIGIN; const host = new URL(publicOrigin).host;
  for (const table of ['audit_events', 'request_revisions', 'tenant_location_revisions', 'tenant_organization_revisions',
    'tenant_catalogue_revisions', 'tenant_booking_policy_revisions', 'tenant_cost_allocation_revisions']) {
    await assert.rejects(scoped.customer.pool.query(`DELETE FROM public.${identifier(table)}`), error => error.code === '42501');
  }
  const exchange = async input => {
    input.signal.throwIfAborted(); const at = performance.now();
    const body = input.body === undefined ? null : JSON.stringify(input.body);
    const response = await targetLoopbackResponse(servers.customer, input.path, host, { method: input.method, body,
      maxBytes: input.binary ? 2 * 1024 * 1024 : 8192, headers: { Cookie: input.cookie, ...(body === null ? {} : {
        Origin: publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': input.csrfToken,
        ...(input.expectedVersion ? { 'If-Match': `"${input.expectedVersion}"` } : {}),
      }) } });
    input.signal.throwIfAborted();
    return { status: response.status, body: input.binary ? response.body : JSON.parse(response.body.toString('utf8')),
      payloadBytes: response.body.length, requestPayloadBytes: body === null ? 0 : Buffer.byteLength(body),
      latencyMs: performance.now() - at };
  };
  const startsAt = new Date(Math.ceil(Date.now() / 86400000) * 86400000 + 7 * 86400000 + 9 * 3600000).toISOString();
  const outcome = await runBookingLoadJourney({ exchange, employee: manifest.employees[0], manager: manifest.managers[0],
    images: Array(3).fill(manifest.images[0]), expectedRooms: manifest.expectedRooms[0],
    context: manifest.configurations[0].context, signal: AbortSignal.timeout(10_000),
    draft: requestLoadDraft({ startsAt, configurationRevisions: manifest.configurations[0].revisions }) });
  assert.equal(outcome.observations.length, 16);
  const request = await reader.query('SELECT status,request_version FROM requests WHERE id=$1', [outcome.requestId]);
  assert.equal(request.rows[0].status, 'Confirmed'); assert.equal(Number(request.rows[0].request_version), 3);
  const diagnostics = await reader.query(`SELECT count(DISTINCT diagnostic.id)::int AS count
    FROM public.platform_diagnostic_events diagnostic JOIN public.audit_events audit
      ON audit.tenant_id=diagnostic.tenant_id AND audit.correlation_id=diagnostic.correlation_id
        AND audit.action=diagnostic.action AND audit.target_type=diagnostic.target_type
        AND audit.occurred_at=diagnostic.occurred_at AND audit.outcome=diagnostic.outcome
    WHERE audit.target_type='request' AND audit.target_id=$1 AND diagnostic.source='tenant_audit'`, [outcome.requestId]);
  const requestAudit = await reader.query(`SELECT count(*)::int AS count FROM public.audit_events
    WHERE target_type='request' AND target_id=$1`, [outcome.requestId]);
  // Reads also produce canonical audit events. Prove complete projection of the
  // actual request audit, rather than confuse three revisions with event count.
  assert.ok(requestAudit.rows[0].count >= 3);
  assert.equal(diagnostics.rows[0].count, requestAudit.rows[0].count);
  const audit = createPostgresAuditRepository(reader, { hmacSecret: env.LOAD_AUDIT_HMAC_SECRET });
  for (const tenantId of manifest.tenants) assert.equal(await audit.verifyTenantChain(tenantId), true);
  let pending;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    pending = (await reader.query('SELECT count(*)::int AS count FROM platform_projection_outbox')).rows[0].count;
    if (pending === 0) break; await delay(50);
  }
  assert.equal(pending, 0);
  const denied = await targetLoopbackJson(servers.platform, '/api/v1/platform/session',
    new URL(environments.platform.LOAD_PUBLIC_ORIGIN).host, { Cookie: manifest.employees[0].cookie });
  assert.equal(denied.status, 401);
  assert.equal((await reader.query('SELECT count(*)::int AS count FROM platform_audit_events')).rows[0].count, 1);
  const grow = (current, population) => growTargetLoadPopulation({
    env: { ...env, LOAD_FIXTURE_USERS: String(population) }, manifest: current,
    persistenceFactory: (config, options) => createPostgresPersistence(localConfig(config, 'setup'), options),
  });
  const thousand = await grow(manifest, 1000);
  assert.equal(thousand.employees.length, 1000); assert.deepEqual(thousand.employees.slice(0, 100), manifest.employees);
  await assert.rejects(grow(manifest, 1000), /^Error: LOAD_TARGET_GROWTH_FAILED$/);
  const tenThousand = await grow(thousand, 10_000);
  assert.equal(tenThousand.employees.length, 10_000); assert.deepEqual(tenThousand.managers, manifest.managers);
  assert.equal((await reader.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 10_010);
  assert.equal((await reader.query('SELECT count(*)::int AS count FROM sessions')).rows[0].count, 10_010);
  const retained = await reader.query('SELECT status,request_version FROM requests WHERE id=$1', [outcome.requestId]);
  assert.equal(retained.rows[0].status, 'Confirmed'); assert.equal(Number(retained.rows[0].request_version), 3);
});
