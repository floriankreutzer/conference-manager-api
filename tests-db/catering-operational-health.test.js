import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringOperationalHealthService } from '../src/application/catering-operational-health-service.js';
import { createCateringDeliveryService } from '../src/application/catering-delivery-service.js';
import { createCateringManualDeliveryService } from '../src/application/catering-manual-delivery-service.js';
import { createCateringVersionService } from '../src/application/catering-version-service.js';
import { createPostgresCateringVersionRepository } from '../src/persistence/postgres/catering-version-repository.js';
import { createCateringWithdrawalService } from '../src/application/catering-withdrawal-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringConfigurationRouteModules } from '../src/catering-configuration-composition.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createPostgresCateringOperationalHealthRepository } from '../src/persistence/postgres/catering-operational-health-repository.js';
import { createPostgresCateringDeliveryRepository } from '../src/persistence/postgres/catering-delivery-repository.js';
import { createPostgresCateringManualDeliveryRepository } from '../src/persistence/postgres/catering-manual-delivery-repository.js';
import { createPostgresCateringWithdrawalRepository } from '../src/persistence/postgres/catering-withdrawal-repository.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { createHttpServer } from '../src/server.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';
import { createCateringDeliveryFixture } from './support/catering-delivery-fixture.js';
import { cateringId as id } from '../tests/support/catering-order-fixture.js';

const ORIGIN = 'http://localhost:3000';
test('actual Customer health summarizes manual facts and withdrawal without writes or Platform disclosure', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const adminPool = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_catering_health_${process.pid}`;
  const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key, `cm_health_${key}_${process.pid}`]));
  let pool;
  t.after(async () => {
    try {
      await pool?.end(); await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await adminPool.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await adminPool.end(); }
  });
  await adminPool.query(`CREATE DATABASE "${name}"`);
  for (const role of Object.values(roles)) await adminPool.query(`CREATE ROLE "${role}" NOLOGIN`);
  const url = new URL(database.databaseUrl); url.pathname = `/${name}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString(), databasePoolMax: 6 });
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  function rolePool(role) {
    const scoped = { async connect() {
      const client = await pool.connect();
      return { async query(query, values) {
        const answer = await client.query(query, values);
        if (typeof query === 'string' && query.startsWith('BEGIN ')) await client.query(`SET LOCAL ROLE "${role}"`);
        return answer;
      }, release(error) { client.release(error); } };
    }, query(query, values) { return withPostgresTransaction(scoped, (client) => client.query(query, values)); } };
    return scoped;
  }
  const customer = rolePool(roles.customer);
  const fixture = await createCateringDeliveryFixture(pool);
  const authorizationPolicy = createAuthorizationPolicy();
  const application = { authorizationPolicy, auditService: fixture.auditService };
  const dependencies = { registry: fixture.registry, auditRepository: fixture.auditRepository };
  const repository = createPostgresCateringOperationalHealthRepository(customer, { registry: fixture.registry });
  const health = createCateringOperationalHealthService({ ...application, registry: fixture.registry, repository,
    processingEnabled: true });
  const delivery = createCateringDeliveryService({ ...application,
    repository: createPostgresCateringDeliveryRepository(customer, dependencies) });
  const manual = createCateringManualDeliveryService({ ...application,
    repository: createPostgresCateringManualDeliveryRepository(customer, dependencies) });
  const withdrawals = createCateringWithdrawalService({ ...application,
    repository: createPostgresCateringWithdrawalRepository(customer, dependencies) });
  const context = fixture.context(); const adminContext = { ...fixture.context(fixture.admin), integrationId: fixture.integrationId };
  const read = () => health.current(adminContext);
  const enqueue = async (view) => {
    await delivery.enqueue({ ...context, schemaVersion: 1, orderId: view.order.orderId, expectedOrderVersion: view.order.orderVersion,
      expectedStateRevision: view.state.revision, expectedQuoteRevision: view.quote.revision });
    return fixture.orders.load({ ...context, orderId: view.order.orderId });
  };
  assert.equal((await read()).state, 'idle');
  let first = await enqueue(await fixture.createApprovedOrder(1));
  let value = await read(); assert.equal(value.state, 'manual_action'); assert.equal(value.counts.manual_action, 1);
  await manual.record({ ...context, schemaVersion: 1, orderId: first.order.orderId, commandId: id(5000),
    expectedOrderVersion: 1, expectedStateRevision: first.state.revision, kind: 'transmitted', channel: 'telephone',
    reference: 'Synthetic health transmission', occurredAt: new Date().toISOString(), receipt: null });
  value = await read(); assert.equal(value.counts.awaiting_confirmation, 1); assert.equal(value.counts.manual_action, 0);
  first = await fixture.orders.load({ ...context, orderId: first.order.orderId });
  await manual.record({ ...context, schemaVersion: 1, orderId: first.order.orderId, commandId: id(5001),
    expectedOrderVersion: 1, expectedStateRevision: first.state.revision, kind: 'receipt', channel: 'telephone',
    reference: 'Synthetic health confirmation', occurredAt: new Date().toISOString(), receipt: {
      orderId: first.order.orderId, orderVersion: 1,
      positions: first.order.positions.map((position) => ({ positionId: position.positionId, outcome: 'confirmed' })),
    } });
  value = await read(); assert.equal(value.state, 'idle'); assert.equal(value.counts.settled, 1);
  assert.equal(value.counts.manual_action, 0); assert.equal(value.oldestOpenAt, null);
  assert.equal((await pool.query('SELECT status FROM catering_delivery_jobs WHERE order_id=$1',
    [first.order.orderId])).rows[0].status, 'queued');
  const stopped = await enqueue(await fixture.createApprovedOrder(2));
  await withdrawals.withdraw({ ...context, schemaVersion: 1, commandId: id(5002), orderId: stopped.order.orderId,
    expectedOrderVersion: 1, expectedStateRevision: stopped.state.revision,
    justification: 'Synthetic untransmitted stop', attestNotTransmitted: true });
  value = await read(); assert.equal(value.counts.superseded, 1); assert.equal(value.counts.settled, 1);
  const versions = createCateringVersionService({ ...application,
    repository: createPostgresCateringVersionRepository(customer, dependencies) });
  await versions.propose({ ...context, schemaVersion: 1, commandId: id(5003), orderId: stopped.order.orderId,
    expectedOrderVersion: 1, expectedStateRevision: stopped.state.revision + 1,
    expectedRequestVersion: 1, expectedAssignmentRevision: 1, operation: 'change',
    justification: 'Synthetic replacement with initial physical support only' });
  let replacement = await fixture.orders.recordQuote({ ...context, schemaVersion: 1, orderId: stopped.order.orderId,
    expectedOrderVersion: 2, expectedStateRevision: 1, expectedQuoteRevision: 0, cost: { amountMinor: 1300, currency: 'EUR' },
    expiresAt: new Date(Date.now() + 3600000).toISOString() });
  replacement = await fixture.orders.decide({ ...context, schemaVersion: 1, orderId: stopped.order.orderId,
    expectedOrderVersion: 2, expectedStateRevision: 2, expectedQuoteRevision: 1, decision: 'approved' });
  await enqueue(replacement);
  value = await read(); assert.equal(value.counts.manual_action, 1); assert.equal(value.counts.paused, 0);
  assert.equal(value.counts.superseded, 1); // A business change is a new first physical order here.
  const leased = await enqueue(await fixture.createApprovedOrder(3));
  // Controlled expired reservation only; no supplier call or dispatch attempt.
  await customer.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='leased',lease_id=$3,
    lease_expires_at=clock_timestamp()-interval '1 second',available_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND order_id=$2`, [fixture.tenantId,leased.order.orderId,id(8000)]);
  value = await read(); assert.equal(value.state, 'attention'); assert.equal(value.expiredLeaseCount, 1);
  assert.equal(value.counts.processing, 1); assert.equal(value.coverage.complete, true);
  assert.doesNotMatch(JSON.stringify(value), /tenantId|orderId|jobId|leaseId|sessionId|reference|cost|credential/);
  await assert.rejects(rolePool(roles.platform).query('SELECT id FROM catering_delivery_jobs'), (error) => error.code === '42501');
  const before = await pool.query('SELECT count(*)::integer AS count FROM audit_events');
  await read(); await read();
  assert.deepEqual((await pool.query('SELECT count(*)::integer AS count FROM audit_events')).rows, before.rows);
  assert.equal((await pool.query('SELECT dispatch_attempts FROM catering_delivery_jobs WHERE order_id=$1',
    [leased.order.orderId])).rows[0].dispatch_attempts, 0);
  await fixture.setOrderCapability(false);
  value = await read(); assert.equal(value.configurationRevision, 2); assert.equal(value.dispatchEnabled, false);
  assert.equal(value.state, 'attention'); // Disabling cannot hide an unresolved reservation.
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN, CATERING_CONFIGURATION_ENABLED: 'true' });
  const modules = createCateringConfigurationRouteModules({ config, ...application,
    persistence: { pool: customer, auditRepository: fixture.auditRepository } });
  const tenants = createPostgresTenantRepository(pool);
  const server = createHttpServer({ config, ...application, additionalRouteModules: modules, sessionService: fixture.sessionService,
    loadTenant: (tenantId) => tenants.findById(tenantId),
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const root = `/api/v1/integrations/catering/${fixture.integrationId}/health`;
  function request(actor, { method = 'GET', suffix = '', csrf = null, body } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: root + suffix,
        headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN,
          ...(actor ? { Cookie: actor.setCookie.split(';',1)[0] } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (response) => {
        const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
      outgoing.on('error', reject); outgoing.end(body);
    });
  }
  assert.equal((await request()).status, 401); assert.equal((await request(fixture.manager)).status, 403);
  const success = await request(fixture.admin); assert.equal(success.status, 200);
  assert.equal(success.body.counts.settled, 1); assert.equal(success.body.counts.superseded, 1);
  assert.equal(success.body.state, 'attention'); assert.equal(success.body.configurationRevision, 2);
  assert.equal((await request(fixture.admin, { suffix: '?tenantId=foreign' })).status, 400);
  assert.equal((await request(fixture.admin, { body: '{}' })).status, 400);
  assert.equal((await request(fixture.admin, { method: 'POST' })).status, 403);
  assert.equal((await request(fixture.admin, { method: 'POST', csrf: fixture.admin.csrfToken })).status, 405);
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Foreign Synthetic Tenant','active')", [id(50)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Foreign Synthetic Admin')", [id(50),id(30)]);
  const foreign = await fixture.sessionService.issue({ tenantId: id(50), userId: id(30), roles: ['tenant_admin'],
    permissions: ['tenant:integrations:manage'], securityVersion: 1,
    providerIdentity: { provider: 'test_identity', reference: 'synthetic-health-foreign' } }, { correlationId: id(90) });
  assert.equal((await request(foreign)).status, 404);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
    [fixture.tenantId,fixture.admin.principal.session.id]);
  assert.equal((await request(fixture.admin)).status, 401);
  assert.equal(await fixture.auditRepository.verifyTenantChain(fixture.tenantId), true);
  const reset = createPostgresDemoResetRepository({ pool: rolePool(roles.reset),
    expectedDatabaseName: name, expectedResetRole: roles.reset });
  assert.equal((await reset.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM })).checksum, DEMO_FIXTURE_CHECKSUM);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_delivery_jobs')).rows[0].count, 0);
});
