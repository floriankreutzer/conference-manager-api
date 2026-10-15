import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { measureRequestCreates, measureSessionReads } from '../scripts/session-load-evidence.mjs';
import { createSessionLoadRuntime } from '../scripts/support/session-load-runtime.mjs';
import { instrumentLoadPool, seedLoadSessions } from './support/customer-load-fixtures.js';
import { requestLoadDraft } from '../tests/support/request-load-draft.js';
import { AUDIT_ACTION } from '../src/audit/event.js';

test('isolated PostgreSQL 18 preserves create integrity under bounded unpaced and fixed-arrival load', async (t) => {
  const databaseUrl = new URL(process.env.DATABASE_URL);
  assert.match(databaseUrl.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl.toString(), DATABASE_SSL: 'disable',
    RATE_LIMIT_MAX: '10000', PUBLIC_ORIGIN: 'http://127.0.0.1:3000', ENTRA_CLIENT_ID: randomUUID(),
    ENTRA_CLIENT_SECRET: randomBytes(32).toString('hex'), OIDC_TRANSACTION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex') }), port: 0 };
  const persistence = createPostgresPersistence(config);
  t.after(() => persistence.close());
  const readCounters = instrumentLoadPool(persistence.pool);
  await migrateUp(persistence.pool);
  const version = Number((await persistence.pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 180_000 && version < 190_000);
  const tenants = Array.from({ length: 10 }, () => randomUUID());
  await persistence.pool.query(`INSERT INTO tenants (id, display_name, status)
    SELECT id, 'Synthetic write fixture', 'active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO sites (tenant_id,id,name,time_zone)
    SELECT id,'site','Synthetic write site','Europe/Berlin' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO rooms (tenant_id,id,site_id,name,capacity)
    SELECT id,'room','site','Synthetic write room',20 FROM unnest($1::uuid[]) AS id`, [tenants]);
  for (let index = 0; index < tenants.length; index += 1) {
    await persistence.pool.query(`INSERT INTO tenant_room_prices (tenant_id,room_id,price_minor,currency,created_at,updated_at)
      VALUES ($1,'room',$2,'EUR',transaction_timestamp(),transaction_timestamp())`, [tenants[index], 1000 + index]);
  }
  await persistence.pool.query(`INSERT INTO rooms (tenant_id,id,site_id,name,capacity)
    VALUES ($1,'foreign-only','site','Synthetic foreign room',20)`, [tenants[1]]);
  const revisions = await Promise.all(tenants.map(async tenantId => {
    const page = await persistence.applicationRepository.loadCatalogPage({ tenantId, section: 'sites', limit: 1 });
    assert.equal(page.status, 'ready'); return page.configurationRevisions;
  }));
  const fixtures = []; let totalCreated = 0;
  const startsAt = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000 + 7 * 86_400_000 + 9 * 3_600_000).toISOString();
  for (const [target, arrivalIntervalMs] of [[100, 0], [1000, 0], [1000, 15], [1000, 5]]) {
    await seedLoadSessions(persistence.pool, tenants, fixtures, target, { roles: ['employee'] });
    const runtime = createSessionLoadRuntime({ config, persistence: { ...persistence, close: async () => {} } });
    try {
      const address = await runtime.start(); config.publicOrigin = `http://127.0.0.1:${address.port}`;
      const cookies = fixtures.map(fixture => fixture.cookie); const csrfTokens = [];
      await measureSessionReads({ origin: config.publicOrigin, cookies, verify(body, index) {
        assert.equal(body.user.id, fixtures[index].userId); assert.equal(body.tenant.id, fixtures[index].tenantId);
        assert.deepEqual(body.roles, ['employee']); csrfTokens[index] = body.csrfToken;
      } });
      const scenario = arrivalIntervalMs ? `${target}/${arrivalIntervalMs}` : String(target);
      const drafts = fixtures.map((fixture, index) => requestLoadDraft({ title: `Synthetic ${scenario} request ${index}`,
        startsAt, configurationRevisions: revisions[tenants.indexOf(fixture.tenantId)] }));
      const clients = await Promise.all(Array.from({ length: config.databasePoolMax }, () => persistence.pool.connect()));
      try { await Promise.all(clients.map(client => client.query('SELECT 1'))); }
      finally { for (const client of clients) client.release(); }
      const responses = []; const ids = new Set(); const before = readCounters();
      const result = await measureRequestCreates({ arrivalIntervalMs, origin: config.publicOrigin, cookies, csrfTokens, drafts,
        verify(body, index) {
          const request = body.request; const tenantIndex = tenants.indexOf(fixtures[index].tenantId);
          assert.equal(body.schemaVersion, 3); assert.equal(request.schemaVersion, 3); assert.equal(request.version, 1);
          assert.equal(request.status, 'Submitted'); assert.equal(request.roomId, 'room');
          assert.equal(request.details.title, drafts[index].title); assert.equal(request.startsAt, startsAt);
          assert.equal(request.endsAt, drafts[index].endsAt); assert.equal(request.internalParticipants, 2);
          assert.equal(request.pricing.totalMinor, 1000 + tenantIndex);
          assert.equal(request.allocations.unallocatedMinor, 1000 + tenantIndex);
          assert.deepEqual(request.configurationRevisions, drafts[index].configurationRevisions);
          assert.deepEqual(request.requesterAttribution, { displayName: 'Synthetic load fixture' });
          assert.equal('tenantId' in request, false); assert.equal('requesterUserId' in request, false);
          assert.match(request.id, /^[0-9a-f-]{36}$/); assert.equal(ids.has(request.id), false);
          ids.add(request.id); responses[index] = request;
        } });
      const after = readCounters();
      const delta = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
      assert.ok(delta.queries > target && delta.bytesRead > 0 && delta.bytesWritten > 0);
      const persisted = await persistence.pool.query(`SELECT r.tenant_id,r.id,r.requester_user_id,r.request_snapshot,
        h.record,h.operation,h.actor_user_id,a.actor_user_id AS audit_actor,a.correlation_id,h.correlation_id AS history_correlation
        FROM requests r JOIN request_revisions h ON h.tenant_id=r.tenant_id AND h.request_id=r.id AND h.request_version=1
        JOIN audit_events a ON a.tenant_id=r.tenant_id AND a.target_id=r.id AND a.action=$2
        WHERE r.id=ANY($1::text[])`, [[...ids], AUDIT_ACTION.REQUEST_CREATED]);
      assert.equal(persisted.rowCount, target);
      const byId = new Map(persisted.rows.map(row => [row.id, row]));
      for (let index = 0; index < target; index += 1) {
        const row = byId.get(responses[index].id); const fixture = fixtures[index];
        assert.equal(row.tenant_id, fixture.tenantId); assert.equal(row.requester_user_id, fixture.userId);
        assert.equal(row.actor_user_id, fixture.userId); assert.equal(row.audit_actor, fixture.userId);
        assert.equal(row.operation, 'created'); assert.equal(row.correlation_id, row.history_correlation);
        assert.deepEqual(row.request_snapshot.details, responses[index].details);
        assert.deepEqual(row.request_snapshot.pricing, responses[index].pricing);
        const { requesterAttribution, ...record } = responses[index];
        assert.deepEqual(requesterAttribution, { displayName: 'Synthetic load fixture' });
        assert.deepEqual(row.record, record);
        const stored = await persistence.requestRepository.findByTenantIdAndId(fixture.tenantId, row.id);
        assert.equal(stored.requesterUserId, fixture.userId);
        assert.equal(await persistence.requestRepository.findByTenantIdAndId(tenants[(index + 1) % 10], row.id), null);
      }
      totalCreated += target;
      for (const [draft, token, status] of [
        [drafts[0], null, 403], [drafts[0], 'x'.repeat(43), 403],
        [{ ...drafts[0], roomId: 'foreign-only' }, csrfTokens[0], 409],
        [{ ...drafts[0], configurationRevisions: { ...drafts[0].configurationRevisions, catalogue: 999 } }, csrfTokens[0], 409],
        [{ ...drafts[0], price: 1 }, csrfTokens[0], 400],
      ]) {
        const response = await fetch(`${config.publicOrigin}/api/v1/application/requests`, { method: 'POST',
          headers: { Cookie: cookies[0], Origin: config.publicOrigin, 'Content-Type': 'application/json',
            ...(token ? { 'X-CSRF-Token': token } : {}) },
          body: JSON.stringify({ schemaVersion: 3, request: draft }), redirect: 'error', signal: AbortSignal.timeout(5000) });
        await response.arrayBuffer(); assert.equal(response.status, status);
      }
      assert.equal(Number((await persistence.pool.query('SELECT count(*) AS count FROM requests')).rows[0].count), totalCreated);
      assert.equal(Number((await persistence.pool.query('SELECT count(*) AS count FROM request_revisions')).rows[0].count),
        totalCreated);
      assert.equal(Number((await persistence.pool.query('SELECT count(*) AS count FROM audit_events WHERE action=$1',
        [AUDIT_ACTION.REQUEST_CREATED])).rows[0].count), totalCreated);
      for (const [index, status] of [[0, 200], [1, 404], [10, 404]]) {
        const response = await fetch(`${config.publicOrigin}/api/v1/requests/${responses[0].id}`, {
          headers: { Cookie: cookies[index] }, redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        await response.arrayBuffer(); assert.equal(response.status, status);
      }
      for (const tenantId of tenants) assert.equal(await persistence.auditRepository.verifyTenantChain(tenantId), true);
      const sloLatency = result.scheduledLatencyMs ?? result.latencyMs;
      const warmSlo = { p95MaxMs: 1_000, p99MaxMs: 2_000, maxTechnicalErrorRate: 0.001,
        technicalErrorRate: 0, latencyBasis: arrivalIntervalMs ? 'scheduled-arrival-to-verified-body' : 'dispatch-to-verified-body',
        met: sloLatency.p95 <= 1_000 && sloLatency.p99 <= 2_000 };
      // Integrity is a deterministic gate; shared-runner latency is reported honestly, not a flaky CI threshold.
      t.diagnostic(JSON.stringify({ schemaVersion: 1, environment: 'isolated-postgres18-loopback', workload: 'request-v3-create',
        fixtureUsers: target, tenants: 10, usersPerTenant: target / 10, poolMax: config.databasePoolMax,
        nodeVersion: process.version, postgresVersion: version, ...result, warmSlo, postgresProtocol: delta,
        providerEgressMeasured: false, productionCapacityProven: false, representativeActivityMixApproved: false }));
    } finally { await runtime.stop(); }
  }
});
