import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { measureRequestCreates, measureSessionReads, measureRequestTransitions } from '../scripts/session-load-evidence.mjs';
import { createSessionLoadRuntime } from '../scripts/support/session-load-runtime.mjs';
import { instrumentLoadPool, seedLoadSessions } from './support/customer-load-fixtures.js';
import { requestLoadDraft } from '../tests/support/request-load-draft.js';
import { AUDIT_ACTION } from '../src/audit/event.js';

test('isolated PostgreSQL manager review/reject load preserves Tenant, versions, history and audit', async (t) => {
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
  assert.ok(version >= 180_000 && version < 190_000);
  const tenants = Array.from({ length: 10 }, () => randomUUID());
  await persistence.pool.query(`INSERT INTO tenants (id,display_name,status)
    SELECT id,'Synthetic transition fixture','active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO sites (tenant_id,id,name,time_zone)
    SELECT id,'site','Synthetic site','Europe/Berlin' FROM unnest($1::uuid[]) AS id`, [tenants]);
  await persistence.pool.query(`INSERT INTO rooms (tenant_id,id,site_id,name,capacity)
    SELECT id,'room','site','Synthetic room',20 FROM unnest($1::uuid[]) AS id`, [tenants]);
  for (let index = 0; index < tenants.length; index += 1) {
    await persistence.pool.query(`INSERT INTO tenant_room_prices (tenant_id,room_id,price_minor,currency,created_at,updated_at)
      VALUES ($1,'room',$2,'EUR',transaction_timestamp(),transaction_timestamp())`, [tenants[index], 1000 + index]);
  }
  const revisions = await Promise.all(tenants.map(async tenantId =>
    (await persistence.applicationRepository.loadCatalogPage({ tenantId, section: 'sites', limit: 1 })).configurationRevisions));
  const employees = []; const managers = [];
  await seedLoadSessions(persistence.pool, tenants, managers, 10, { roles: ['conference_manager'] });
  let created = 0;
  for (const target of [100, 1000]) {
    await seedLoadSessions(persistence.pool, tenants, employees, target, { roles: ['employee'] });
    const runtime = createSessionLoadRuntime({ config, persistence: { ...persistence, close: async () => {} } });
    try {
      const address = await runtime.start(); config.publicOrigin = `http://127.0.0.1:${address.port}`;
      const employeeTokens = []; const managerTokens = [];
      for (const [fixtures, tokens] of [[employees, employeeTokens], [managers, managerTokens]]) {
        await measureSessionReads({ origin: config.publicOrigin, cookies: fixtures.map(x => x.cookie), verify(body, index) {
          assert.equal(body.user.id, fixtures[index].userId); assert.equal(body.tenant.id, fixtures[index].tenantId);
          assert.deepEqual(body.roles, fixtures[index].roles); tokens[index] = body.csrfToken;
        } });
      }
      const startsAt = new Date(Math.ceil(Date.now() / 86400000) * 86400000 + 7 * 86400000 + 9 * 3600000).toISOString();
      const responses = [];
      await measureRequestCreates({ origin: config.publicOrigin, cookies: employees.map(x => x.cookie),
        csrfTokens: employeeTokens, drafts: employees.map((x, index) => requestLoadDraft({ startsAt,
          title: `Synthetic transition ${target}/${index}`, configurationRevisions: revisions[tenants.indexOf(x.tenantId)] })),
        verify(body, index) { assert.equal(body.request.status, 'Submitted'); assert.equal(body.request.version, 1);
          responses[index] = body.request; } });
      created += target;
      const command = async (index, cookie, csrf, transition, expectedVersion) => {
        const response = await fetch(`${config.publicOrigin}/api/v1/requests/${responses[index].id}/transitions`, {
          method: 'POST', headers: { Cookie: cookie, Origin: config.publicOrigin, 'Content-Type': 'application/json',
            'If-Match': `"${expectedVersion}"`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
          body: JSON.stringify({ transition, ...(transition === 'reject' ? { reason: 'Synthetic isolated load decision' } : {}) }),
          redirect: 'error', signal: AbortSignal.timeout(5000) });
        await response.arrayBuffer(); return response.status;
      };
      assert.equal(await command(0, employees[0].cookie, employeeTokens[0], 'start_review', 1), 403);
      assert.equal(await command(0, managers[1].cookie, managerTokens[1], 'start_review', 1), 404);
      assert.equal(await command(0, managers[0].cookie, null, 'start_review', 1), 403);
      const results = [];
      for (const [transition, status, expectedVersion] of [['start_review', 'In Review', 2], ['reject', 'Rejected', 3]]) {
        const clients = await Promise.all(Array.from({ length: config.databasePoolMax }, () => persistence.pool.connect()));
        try { await Promise.all(clients.map(client => client.query('SELECT 1'))); }
        finally { for (const client of clients) client.release(); }
        const before = counters();
        const result = await measureRequestTransitions({ origin: config.publicOrigin,
          requestIds: responses.map(x => x.id), transition,
          cookies: employees.map(x => managers[tenants.indexOf(x.tenantId)].cookie),
          csrfTokens: employees.map(x => managerTokens[tenants.indexOf(x.tenantId)]), verify(body, index) {
            const actual = body.request;
            assert.equal(actual.id, responses[index].id); assert.equal(actual.status, status);
            assert.equal(actual.version, expectedVersion); assert.equal(actual.roomId, 'room');
            assert.deepEqual(actual.details, responses[index].details);
            assert.deepEqual(actual.pricing, responses[index].pricing);
            assert.deepEqual(actual.allocations, responses[index].allocations);
            assert.equal(actual.pricing.totalMinor, 1000 + tenants.indexOf(employees[index].tenantId));
            assert.equal('tenantId' in actual, false); assert.equal('requesterUserId' in actual, false);
          } });
        const after = counters();
        const protocol = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
        assert.ok(protocol.queries > 0 && protocol.bytesRead > 0 && protocol.bytesWritten > 0);
        results.push({ transition, ...result, postgresProtocol: protocol });
      }
      assert.equal(await command(0, managers[0].cookie, managerTokens[0], 'reject', 2), 409);
      const rows = await persistence.pool.query(`SELECT r.tenant_id,r.id,r.request_version AS version,r.status,
        h.request_version,h.operation,h.actor_user_id,h.actor_role_at_action,h.correlation_id,
        a.actor_user_id AS audit_actor,a.correlation_id AS audit_correlation
        FROM requests r JOIN request_revisions h ON h.tenant_id=r.tenant_id AND h.request_id=r.id
        JOIN audit_events a ON a.tenant_id=h.tenant_id AND a.correlation_id=h.correlation_id AND a.action=$2
        WHERE r.id=ANY($1::text[]) AND h.request_version IN (2,3)`, [responses.map(x => x.id), AUDIT_ACTION.REQUEST_TRANSITION]);
      assert.equal(rows.rowCount, target * 2);
      const expected = new Map(responses.map((row, index) => [row.id, employees[index]]));
      for (const row of rows.rows) {
        const fixture = expected.get(row.id); const manager = managers[tenants.indexOf(fixture.tenantId)];
        assert.equal(row.tenant_id, fixture.tenantId); assert.equal(row.status, 'Rejected');
        assert.equal(Number(row.version), 3); assert.equal(row.operation, 'transitioned');
        assert.equal(row.actor_user_id, manager.userId); assert.equal(row.audit_actor, manager.userId);
        assert.equal(row.actor_role_at_action, 'conference_manager'); assert.equal(row.correlation_id, row.audit_correlation);
      }
      assert.equal(Number((await persistence.pool.query('SELECT count(*) AS count FROM requests')).rows[0].count), created);
      assert.equal(Number((await persistence.pool.query('SELECT count(*) AS count FROM request_revisions')).rows[0].count), created * 3);
      for (const tenantId of tenants) assert.equal(await persistence.auditRepository.verifyTenantChain(tenantId), true);
      for (const result of results) t.diagnostic(JSON.stringify({ schemaVersion: 1,
        environment: 'isolated-postgres18-loopback', workload: 'request-manager-transition', fixtureUsers: target,
        tenants: 10, poolMax: config.databasePoolMax, nodeVersion: process.version, postgresVersion: version,
        ...result, warmSlo: { p95MaxMs: 1000, p99MaxMs: 2000, technicalErrorRate: 0,
          met: result.latencyMs.p95 <= 1000 && result.latencyMs.p99 <= 2000 }, providerEgressMeasured: false,
        productionCapacityProven: false, representativeActivityMixApproved: false }));
    } finally { await runtime.stop(); }
  }
});
