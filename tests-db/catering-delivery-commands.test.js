import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringDeliveryService } from '../src/application/catering-delivery-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringDeliveryRouteModules } from '../src/catering-delivery-composition.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createPostgresCateringDeliveryRepository } from '../src/persistence/postgres/catering-delivery-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createHttpServer } from '../src/server.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';
import { createCateringDeliveryFixture } from './support/catering-delivery-fixture.js';
import { cateringId as id } from '../tests/support/catering-order-fixture.js';

const ROOT = '/api/v1/tenant/catering/delivery-jobs';
const ORIGIN = 'http://localhost:3000';
test('actual Customer enqueue is atomic, session-fenced, idempotent and Tenant scoped through real HTTP-CSRF', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database, databasePoolMax: 6 });
  const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key, `cm_delivery_command_${key}_${process.pid}`]));
  // Role objects are cluster-wide; the outer isolated test database owns all rows.
  t.after(async () => {
    for (const role of Object.values(roles)) await pool.query(`DROP OWNED BY "${role}"`);
    for (const role of Object.values(roles)) await pool.query(`DROP ROLE "${role}"`);
    await pool.end();
  });
  for (const role of Object.values(roles)) await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const fixture = await createCateringDeliveryFixture(pool);
  const authorizationPolicy = createAuthorizationPolicy();
  const customer = {
    async connect() {
      const client = await pool.connect();
      return { async query(query, values) {
        const answer = await client.query(query, values);
        if (typeof query === 'string' && query.startsWith('BEGIN ')) await client.query(`SET LOCAL ROLE "${roles.customer}"`);
        return answer;
      }, release(error) { client.release(error); } };
    },
    query(query, values) { return withPostgresTransaction(customer, (client) => client.query(query, values)); },
  };
  const make = (auditRepository = fixture.auditRepository) => {
    const repository = createPostgresCateringDeliveryRepository(customer, { registry: fixture.registry, auditRepository });
    return createCateringDeliveryService({ repository, authorizationPolicy, auditService: fixture.auditService });
  };
  const service = make();
  const view = await fixture.createApprovedOrder(); const orderId = view.order.orderId;
  const command = { ...fixture.context(), schemaVersion: 1, orderId,
    expectedOrderVersion: 1, expectedStateRevision: 3, expectedQuoteRevision: 1 };
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_delivery_jobs')).rows[0].n, 0);
  for (const extra of [{ expectedStateRevision: 2 }, { expectedOrderVersion: 2 }, { expectedQuoteRevision: 2 }]) {
    await assert.rejects(service.enqueue({ ...command, ...extra }), /CONFLICT|CHANGED|UNAVAILABLE/);
  }
  await assert.rejects(make({ async appendWithClient() { throw new Error('SYNTHETIC_AUDIT_UNAVAILABLE'); } }).enqueue(command),
    /SYNTHETIC_AUDIT_UNAVAILABLE/);
  assert.equal((await fixture.orders.load({ ...fixture.context(), orderId })).state.status, 'released');
  assert.equal((await service.list(fixture.context())).jobs.length, 0);
  await fixture.setOrderCapability(false);
  await assert.rejects(service.enqueue(command), /APPROVAL_UNAVAILABLE/);
  assert.equal((await fixture.orders.load({ ...fixture.context(), orderId })).state.status, 'released');
  await fixture.setOrderCapability(true);
  const concurrent = await Promise.all([service.enqueue(command), service.enqueue(command)]);
  assert.deepEqual(concurrent.map((value) => value.replayed).sort(), [false,true]);
  const jobId = concurrent[0].job.jobId; assert.equal(concurrent[1].job.jobId, jobId);
  assert.equal((await fixture.orders.load({ ...fixture.context(), orderId })).state.revision, 4);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM audit_events WHERE action='catering.delivery.queued'"))
    .rows[0].n, 1);
  await assert.rejects(service.enqueue({ ...command, expectedStateRevision: 4 }), /ALREADY_ENQUEUED/);
  assert.equal((await service.enqueue(command)).replayed, true);
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Foreign Synthetic Tenant','active')", [id(50)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Foreign Synthetic Manager')", [id(50),id(20)]);
  const foreign = await fixture.sessionService.issue({ tenantId: id(50), userId: id(20), roles: ['conference_manager'],
    permissions: ['request:manage'], securityVersion: 1,
    providerIdentity: { provider: 'test_identity', reference: 'synthetic-foreign' } }, { correlationId: id(90) });
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN,
    CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' });
  const modules = createCateringDeliveryRouteModules({ config, persistence: { pool: customer, auditRepository: fixture.auditRepository },
    authorizationPolicy, auditService: fixture.auditService });
  const tenantRepository = createPostgresTenantRepository(pool);
  const server = createHttpServer({ config, additionalRouteModules: modules, authorizationPolicy, auditService: fixture.auditService,
    sessionService: fixture.sessionService, loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  function request(actor, { method = 'GET', path = ROOT, csrf = actor?.csrfToken, origin = ORIGIN, body } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path, headers: {
        Host: new URL(ORIGIN).host, Origin: origin, ...(actor ? { Cookie: actor.setCookie.split(';',1)[0] } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      } }, (response) => {
        const bytes = []; response.on('data', (chunk) => bytes.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(bytes).toString('utf8')) }));
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
      outgoing.on('error', reject); outgoing.end(body);
    });
  }
  const wireCommand = JSON.stringify({ schemaVersion: 1, orderId, expectedOrderVersion: 1,
    expectedStateRevision: 3, expectedQuoteRevision: 1 });
  assert.equal((await request()).status, 401);
  assert.equal((await request(fixture.admin)).status, 403);
  assert.equal((await request(fixture.manager)).status, 200);
  assert.deepEqual((await request(foreign)).body.jobs, []);
  assert.equal((await request(foreign, { path: `${ROOT}/${jobId}` })).status, 404);
  assert.equal((await request(foreign, { method: 'POST', body: wireCommand })).status, 404);
  for (const extra of [{ csrf: null }, { csrf: 'x'.repeat(43) }, { csrf: foreign.csrfToken },
    { origin: 'https://foreign.invalid' }]) {
    assert.equal((await request(fixture.manager, { method: 'POST', body: wireCommand, ...extra })).status, 403);
  }
  assert.equal((await request(fixture.manager, { method: 'POST', body: wireCommand })).body.replayed, true);
  assert.equal((await request(fixture.manager, { path: `${ROOT}/${jobId}` })).body.job.jobId, jobId);
  assert.equal(await fixture.auditRepository.verifyTenantChain(id(1)), true);
  for (let sequence = 2; sequence <= 22; sequence++) {
    const prepared = await fixture.createApprovedOrder(sequence);
    await service.enqueue({ ...command, orderId: prepared.order.orderId });
  }
  const firstPage = await service.list(fixture.context());
  assert.equal(firstPage.jobs.length, 20); assert.equal(firstPage.nextAfterJobId, firstPage.jobs.at(-1).jobId);
  const lastPage = await service.list({ ...fixture.context(), afterJobId: firstPage.nextAfterJobId });
  assert.equal(lastPage.jobs.length, 2); assert.equal(lastPage.nextAfterJobId, null);
  assert.equal(new Set([...firstPage.jobs,...lastPage.jobs].map((job) => job.jobId)).size, 22);
  const filtered = await service.list({ ...fixture.context(), orderId });
  assert.deepEqual(filtered.jobs.map((job) => job.jobId), [jobId]);
  const second = await fixture.createApprovedOrder(1);
  const revokedCommand = { ...command, orderId: second.order.orderId };
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
    [id(1),fixture.manager.principal.session.id]);
  await assert.rejects(service.enqueue(revokedCommand));
  assert.equal((await request(fixture.manager)).status, 401);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_delivery_jobs')).rows[0].n, 22);
});
