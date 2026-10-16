import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { measureRoomAvailability, measureRequestCreates, measureSessionReads } from '../scripts/session-load-evidence.mjs';
import { createSessionLoadRuntime } from '../scripts/support/session-load-runtime.mjs';
import { instrumentLoadPool, seedLoadSessions } from './support/customer-load-fixtures.js';
import { requestLoadDraft } from '../tests/support/request-load-draft.js';

test('isolated PostgreSQL availability distinguishes local conflict from bound provider fixture work', async (t) => {
  const url = new URL(process.env.DATABASE_URL);
  assert.match(url.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), DATABASE_SSL: 'disable',
    RATE_LIMIT_MAX: '10000', PUBLIC_ORIGIN: 'http://127.0.0.1:3000', ENTRA_CLIENT_ID: randomUUID(),
    ENTRA_CLIENT_SECRET: randomBytes(32).toString('hex'), OIDC_TRANSACTION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex') }), port: 0 };
  const persistence = createPostgresPersistence(config); t.after(() => persistence.close());
  const counters = instrumentLoadPool(persistence.pool); await migrateUp(persistence.pool);
  const version = Number((await persistence.pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 180000 && version < 190000);
  const tenants = Array.from({ length: 10 }, () => randomUUID()); const bindings = new Map();
  await persistence.pool.query(`INSERT INTO tenants(id,display_name,status)
    SELECT id,'Synthetic availability fixture','active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO sites(tenant_id,id,name,time_zone)
    SELECT id,'site','Synthetic site','Europe/Berlin' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity)
    SELECT id,'room','site','Synthetic room',20 FROM unnest($1::uuid[]) AS id`, [tenants]);
  for (let index = 0; index < tenants.length; index += 1) {
    const tenantId = tenants[index]; const integration = randomUUID(); const reference = randomUUID();
    const address = `room${index}@synthetic.invalid`; bindings.set(reference, { index, address });
    await persistence.pool.query(`INSERT INTO tenant_room_prices(tenant_id,room_id,price_minor,currency,created_at,updated_at)
      VALUES($1,'room',$2,'EUR',transaction_timestamp(),transaction_timestamp())`, [tenantId, 1000 + index]);
    await persistence.pool.query(`INSERT INTO tenant_entitlements(tenant_id,capability_id,enabled)
      VALUES($1,'microsoft.calendar',true)`, [tenantId]);
    await persistence.pool.query(`INSERT INTO tenant_identity_bindings
      (id,tenant_id,provider,provider_tenant_reference,status,created_at,updated_at)
      VALUES($1,$2,'microsoft_entra',$3,'active',transaction_timestamp(),transaction_timestamp())`,
    [randomUUID(), tenantId, reference]);
    await persistence.pool.query(`INSERT INTO integrations
      (tenant_id,id,provider,provider_reference,status,connection_version,last_verified_at,
       places_permission_status,calendars_permission_status,created_at,updated_at)
      VALUES($1,$2,'microsoft365',$3,'connected',1,transaction_timestamp(),'granted','granted',
      transaction_timestamp(),transaction_timestamp())`, [tenantId, integration, reference]);
    await persistence.pool.query(`INSERT INTO microsoft365_room_mappings
      (tenant_id,room_id,integration_id,external_room_id,resource_address,provider_display_name,provider_capacity,
       last_seen_at,created_at,updated_at) VALUES($1,'room',$2,$3,$4,'Synthetic room',20,
       transaction_timestamp(),transaction_timestamp(),transaction_timestamp())`, [tenantId, integration, randomUUID(), address]);
  }
  await persistence.pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity)
    VALUES($1,'foreign-only','site','Foreign synthetic room',20)`, [tenants[1]]);
  const revisions = await Promise.all(tenants.map(async tenantId =>
    (await persistence.applicationRepository.loadCatalogPage({ tenantId, section: 'sites', limit: 1 })).configurationRevisions));
  const fixtures = []; let calls = 0; let providerSlot;
  const startsAt = new Date(Math.ceil(Date.now() / 86400000) * 86400000 + 7 * 86400000 + 9 * 3600000).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 3600000).toISOString();
  const lookupFreeBusy = async ({ tenantReference, schedules, startsAt: actualStart, endsAt: actualEnd }) => {
    const binding = bindings.get(tenantReference); assert.ok(binding);
    assert.deepEqual(schedules, [binding.address]); assert.equal(actualStart, providerSlot.startsAt);
    assert.equal(actualEnd, providerSlot.endsAt); calls += 1;
    return [{ schedule: binding.address, available: binding.index === 0,
      conflictCount: binding.index === 0 ? 0 : binding.index + 1 }];
  };
  for (const target of [100, 1000]) {
    await seedLoadSessions(persistence.pool, tenants, fixtures, target, { roles: ['employee'] });
    const runtime = createSessionLoadRuntime({ config, persistence: { ...persistence, close: async () => {} }, lookupFreeBusy });
    try {
      const address = await runtime.start(); config.publicOrigin = `http://127.0.0.1:${address.port}`;
      const csrf = [];
      await measureSessionReads({ origin: config.publicOrigin, cookies: fixtures.map(x => x.cookie), verify(body, index) {
        assert.equal(body.user.id, fixtures[index].userId); assert.equal(body.tenant.id, fixtures[index].tenantId);
        assert.deepEqual(body.roles, ['employee']); csrf[index] = body.csrfToken;
      } });
      if (target === 100) await measureRequestCreates({ origin: config.publicOrigin,
        cookies: fixtures.slice(0, 10).map(x => x.cookie), csrfTokens: csrf.slice(0, 10),
        drafts: fixtures.slice(0, 10).map((x, index) => requestLoadDraft({ startsAt, configurationRevisions: revisions[index] })),
        verify(body) { assert.equal(body.request.status, 'Submitted'); } });
      const results = [];
      for (const phase of ['provider-fixture', 'local-conflict']) {
        const slot = phase === 'local-conflict' ? { startsAt, endsAt }
          : { startsAt: new Date(Date.parse(startsAt) + 7200000).toISOString(),
            endsAt: new Date(Date.parse(endsAt) + 7200000).toISOString() };
        providerSlot = slot; calls = 0;
        const clients = await Promise.all(Array.from({ length: config.databasePoolMax }, () => persistence.pool.connect()));
        try { await Promise.all(clients.map(client => client.query('SELECT 1'))); }
        finally { clients.forEach(client => client.release()); }
        const before = counters();
        const result = await measureRoomAvailability({ origin: config.publicOrigin, ...slot, csrfTokens: csrf,
          cookies: fixtures.map(x => x.cookie), verify(body, index) {
            const tenantIndex = tenants.indexOf(fixtures[index].tenantId);
            assert.deepEqual(body, { schemaVersion: 1, availability: phase === 'local-conflict' ? { available: false, conflictCount: 1 }
              : { available: tenantIndex === 0, conflictCount: tenantIndex === 0 ? 0 : tenantIndex + 1 } });
          } });
        const after = counters();
        const protocol = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
        assert.ok(protocol.queries > 0 && protocol.bytesRead > 0 && protocol.bytesWritten > 0);
        assert.equal(calls, phase === 'local-conflict' ? 0 : target);
        results.push({ phase, ...result, postgresProtocol: protocol, simulatedProviderCalls: calls });
      }
      for (const [body, token, expected] of [
        [{ roomId: 'foreign-only', startsAt, endsAt }, csrf[0], 404],
        [{ roomId: 'room', startsAt, endsAt }, null, 403],
        [{ roomId: 'room', startsAt, endsAt }, 'x'.repeat(43), 403],
        [{ roomId: 'room', startsAt, endsAt, tenantId: tenants[1] }, csrf[0], 400],
      ]) {
        const response = await fetch(`${config.publicOrigin}/api/v1/application/room-availability`, {
          method: 'POST', headers: { Cookie: fixtures[0].cookie, Origin: config.publicOrigin,
            'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) },
          body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) });
        await response.arrayBuffer(); assert.equal(response.status, expected); assert.equal(calls, 0);
      }
      assert.equal((await persistence.pool.query('SELECT count(*)::int AS count FROM requests')).rows[0].count, 10);
      const health = await persistence.pool.query(`SELECT tenant_id,status,last_checked_at,last_success_at
        FROM microsoft365_capability_health WHERE capability='free_busy' ORDER BY tenant_id`);
      assert.deepEqual(health.rows.map(row => row.tenant_id).sort(), [...tenants].sort());
      assert.ok(health.rows.every(row => row.status === 'healthy' && row.last_success_at !== null
        && row.last_checked_at.getTime() >= row.last_success_at.getTime()));
      for (const tenantId of tenants) assert.equal(await persistence.auditRepository.verifyTenantChain(tenantId), true);
      for (const result of results) console.log(JSON.stringify({ schemaVersion: 1,
        environment: 'isolated-postgres18-loopback', workload: 'room-availability', fixtureUsers: target,
        tenants: 10, poolMax: config.databasePoolMax, nodeVersion: process.version, postgresVersion: version, ...result,
        provider: 'deterministic-in-process-fixture', actualProviderLatencyMeasured: false, providerEgressMeasured: false,
        productionCapacityProven: false, representativeMixedReplay: false,
        warmSlo: { p95MaxMs: 1000, p99MaxMs: 2000, technicalErrorRate: 0,
          met: result.latencyMs.p95 <= 1000 && result.latencyMs.p99 <= 2000 } }));
    } finally { await runtime.stop(); }
  }
});
