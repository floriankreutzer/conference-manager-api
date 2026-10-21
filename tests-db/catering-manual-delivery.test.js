import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringDeliveryService } from '../src/application/catering-delivery-service.js';
import { createCateringManualDeliveryService } from '../src/application/catering-manual-delivery-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringDeliveryRouteModules } from '../src/catering-delivery-composition.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createPostgresCateringDeliveryRepository } from '../src/persistence/postgres/catering-delivery-repository.js';
import { createPostgresCateringManualDeliveryRepository } from '../src/persistence/postgres/catering-manual-delivery-repository.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { createHttpServer } from '../src/server.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { migrateDemoUp, rollbackLatestDemoMigration } from '../scripts/demo-db-migrations.mjs';
import { createCateringDeliveryFixture } from './support/catering-delivery-fixture.js';
import { cateringId as id } from '../tests/support/catering-order-fixture.js';

const ORIGIN = 'http://localhost:3000';
test('actual Customer manual facts are immutable, atomic, session-fenced and independently confirmed through HTTP', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_manual_${process.pid}`;
  const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key, `cm_manual_${key}_${process.pid}`]));
  let pool;
  t.after(async () => {
    try {
      await pool?.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
  const url = new URL(database.databaseUrl); url.pathname = `/${name}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString(), databasePoolMax: 6 });
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catalogue source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Platform passkey reset grants019 before schema053.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Unsent grants018 before schema052.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Version grants017.
  await rollbackLatestDemoMigration(pool, { roles });
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version schema051.
  assert.equal(await rollbackLatest(pool), true); assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const fixture = await createCateringDeliveryFixture(pool, { extraCount: 1 });
  const authorizationPolicy = createAuthorizationPolicy();
  function rolePool(role) {
    const scoped = {
      async connect() {
        const client = await pool.connect();
        return { async query(query, values) {
          const answer = await client.query(query, values);
          if (typeof query === 'string' && query.startsWith('BEGIN ')) await client.query(`SET LOCAL ROLE "${role}"`);
          return answer;
        }, release(error) { client.release(error); } };
      },
      query(query, values) { return withPostgresTransaction(scoped, (client) => client.query(query, values)); },
    };
    return scoped;
  }
  const customer = rolePool(roles.customer); const resetPool = rolePool(roles.reset);
  const privileges = (await pool.query(`SELECT
    has_table_privilege($1,'catering_manual_delivery_facts','INSERT') AS append,
    has_table_privilege($1,'catering_manual_delivery_facts','UPDATE') AS mutate,
    has_table_privilege($1,'catering_manual_delivery_facts','DELETE') AS erase,
    has_table_privilege($2,'catering_manual_delivery_facts','SELECT') AS platform,
    has_table_privilege($3,'catering_manual_delivery_facts','TRUNCATE') AS reset,
    has_function_privilege($1,'verify_catering_manual_delivery_head()','EXECUTE') AS direct`,
  [roles.customer,roles.platform,roles.reset])).rows[0];
  assert.deepEqual(privileges, { append: true, mutate: false, erase: false, platform: false, reset: true, direct: false });
  await assert.rejects(rolePool(roles.platform).query('SELECT * FROM catering_manual_delivery_facts'),
    (error) => error.code === '42501');
  const make = (auditRepository = fixture.auditRepository) => createCateringManualDeliveryService({ authorizationPolicy,
    auditService: fixture.auditService,
    repository: createPostgresCateringManualDeliveryRepository(customer, { registry: fixture.registry, auditRepository }) });
  const service = make();
  const delivery = createCateringDeliveryService({ authorizationPolicy, auditService: fixture.auditService,
    repository: createPostgresCateringDeliveryRepository(customer, { registry: fixture.registry,
      auditRepository: fixture.auditRepository }) });
  let next = 2000;
  const command = (orderId, revision = 4, extra = {}) => ({ ...fixture.context(), orderId, schemaVersion: 1,
    commandId: id(next++), expectedOrderVersion: 1, expectedStateRevision: revision,
    kind: 'transmitted', channel: 'telephone', reference: 'Synthetic record #1', occurredAt: new Date().toISOString(), receipt: null,
    ...extra });
  async function queued(sequence) {
    const view = await fixture.createApprovedOrder(sequence);
    await delivery.enqueue({ ...fixture.context(), schemaVersion: 1, orderId: view.order.orderId,
      expectedOrderVersion: 1, expectedStateRevision: 3, expectedQuoteRevision: 1 });
    return view;
  }
  const view = await queued(0); const orderId = view.order.orderId;
  const receipt = (outcomes) => ({ orderId, orderVersion: 1,
    positions: view.order.positions.map((position, index) => ({ positionId: position.positionId, outcome: outcomes[index] })) });
  assert.equal(view.order.positions.length, 2);
  assert.equal((await service.load({ ...fixture.context(), orderId })).effective, null);
  await assert.rejects(service.record(command(orderId, 4, { kind: 'receipt', receipt: receipt(['pending','pending']) })),
    /TRANSMISSION_REQUIRED/);
  await assert.rejects(service.record(command(orderId, 3)), /REVISION_CONFLICT/);
  await assert.rejects(service.record(command(orderId, 4, { occurredAt: new Date(Date.now() + 60000).toISOString() })), /TIME_CONFLICT/);
  await assert.rejects(service.record(command(orderId, 4, { occurredAt: '2020-01-01T00:00:00.000Z' })), /TIME_CONFLICT/);
  const transmitted = command(orderId);
  await assert.rejects(make({ async appendWithClient() { throw new Error('SYNTHETIC_MANUAL_AUDIT_UNAVAILABLE'); } })
    .record(transmitted), /SYNTHETIC_MANUAL_AUDIT_UNAVAILABLE/);
  assert.equal((await service.load({ ...fixture.context(), orderId })).manualSequence, 0);
  assert.equal((await fixture.orders.load({ ...fixture.context(), orderId })).state.status, 'queued');
  const concurrent = await Promise.all([service.record(transmitted), service.record(transmitted)]);
  assert.deepEqual(concurrent.map((value) => value.replayed).sort(), [false,true]);
  assert.equal(concurrent[0].fact.sequence, 1); assert.equal(concurrent[0].orderState.status, 'transmitted');
  assert.doesNotMatch(JSON.stringify(concurrent[0]), /actorUserId|securityVersion|sessionId|tenantId|commandId/);
  await assert.rejects(service.record({ ...transmitted, reference: 'different' }), /COMMAND_CONFLICT/);
  await assert.rejects(service.record(command(orderId, 5)), /ALREADY_TRANSMITTED/);
  const foreignReceipt = receipt(['confirmed','pending']); foreignReceipt.positions[1].positionId = id(999);
  await assert.rejects(service.record(command(orderId, 5, { kind: 'receipt', receipt: foreignReceipt })), /RECEIPT_CONFLICT/);
  const partial = await service.record(command(orderId, 5, { kind: 'receipt', receipt: receipt(['confirmed','substitution_proposed']) }));
  assert.equal(partial.orderState.status, 'partially_confirmed');
  assert.equal((await service.load({ ...fixture.context(), orderId })).effective, null);
  const rejected = await service.record(command(orderId, 6, { kind: 'receipt', receipt: receipt(['rejected','rejected']) }));
  assert.equal(rejected.orderState.status, 'rejected');
  await assert.rejects(fixture.orders.recordQuote({ ...fixture.context(), schemaVersion: 1, orderId,
    expectedStateRevision: 7, expectedQuoteRevision: 1, cost: { amountMinor: 0, currency: 'EUR' },
    expiresAt: new Date(Date.now() + 3600000).toISOString() }), /CONFLICT|DELIVERY_IN_PROGRESS/);
  assert.equal((await service.load({ ...fixture.context(), orderId })).effective, null);
  const confirmed = await service.record(command(orderId, 7, { kind: 'receipt', receipt: receipt(['confirmed','confirmed']) }));
  assert.equal(confirmed.orderState.status, 'confirmed');
  assert.deepEqual((await service.load({ ...fixture.context(), orderId })).effective, { orderVersion: 1, status: 'confirmed' });
  await assert.rejects(service.record(command(orderId, 8, { kind: 'receipt', receipt: receipt(['pending','pending']) })),
    /TERMINAL_CONFLICT/);
  assert.equal((await service.record(transmitted)).replayed, true);
  for (let sequence = 5; sequence <= 21; sequence++) {
    await service.record(command(orderId, sequence + 3, { kind: 'receipt', receipt: receipt(['confirmed','confirmed']) }));
  }
  const first = await service.load({ ...fixture.context(), orderId });
  assert.equal(first.events.length, 20); assert.equal(first.manualSequence, 21); assert.equal(first.nextAfterSequence, 20);
  const tail = await service.load({ ...fixture.context(), orderId, orderVersion: 1, afterSequence: 20 });
  assert.equal(tail.events.length, 1); assert.equal(tail.events[0].sequence, 21); assert.equal(tail.nextAfterSequence, null);
  assert.equal((await service.load({ ...fixture.context(), orderId, afterSequence: 99 })).events.length, 0);
  for (const sql of ['UPDATE catering_manual_delivery_facts SET reference=reference', 'DELETE FROM catering_manual_delivery_facts']) {
    await assert.rejects(customer.query(sql), (error) => error.code === '42501');
    await assert.rejects(pool.query(sql), /CATERING_ORDER_HISTORY_APPEND_ONLY/);
  }
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catalogue source grants020.
  await rollbackLatestDemoMigration(pool, { roles }); // Platform passkey reset grants019 before schema053.
  await rollbackLatestDemoMigration(pool, { roles }); // Unsent grants018 before schema052.
  await rollbackLatestDemoMigration(pool, { roles }); // Revoke017 before recreating051.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty051; retain populated050 evidence.
  await assert.rejects(rollbackLatest(pool), /CATERING_MANUAL_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  assert.equal(await fixture.auditRepository.verifyTenantChain(fixture.tenantId), true);
  const manualAudit = await pool.query("SELECT metadata FROM audit_events WHERE action LIKE 'catering.manual.%'");
  assert.equal(manualAudit.rowCount, 21);
  assert.doesNotMatch(JSON.stringify(manualAudit.rows), /Synthetic record|telephone|reference|positions|amountMinor/);
  const job = (await pool.query('SELECT dispatch_attempts,status FROM catering_delivery_jobs WHERE order_id=$1', [orderId])).rows[0];
  assert.deepEqual(job, { dispatch_attempts: 0, status: 'queued' });
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Foreign Synthetic Tenant','active')", [id(50)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Foreign Synthetic Manager')", [id(50),id(20)]);
  const foreign = await fixture.sessionService.issue({ tenantId: id(50), userId: id(20), roles: ['conference_manager'],
    permissions: ['request:manage'], securityVersion: 1,
    providerIdentity: { provider: 'test_identity', reference: 'synthetic-foreign' } }, { correlationId: id(90) });
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN,
    CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' });
  const modules = createCateringDeliveryRouteModules({ config, persistence: { pool: customer, auditRepository: fixture.auditRepository },
    authorizationPolicy, auditService: fixture.auditService });
  const tenants = createPostgresTenantRepository(pool);
  const server = createHttpServer({ config, additionalRouteModules: modules, authorizationPolicy, auditService: fixture.auditService,
    sessionService: fixture.sessionService, loadTenant: (tenantId) => tenants.findById(tenantId),
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const root = `/api/v1/tenant/catering/orders/${orderId}/manual-delivery`;
  function request(actor, { method = 'GET', csrf = actor?.csrfToken, origin = ORIGIN, path = root, body } = {}) {
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
  const { principal: _principal, tenantContext: _tenant, correlationId: _correlation, orderId: _order, ...wire } = transmitted;
  const body = JSON.stringify(wire);
  assert.equal((await request()).status, 401); assert.equal((await request(fixture.admin)).status, 403);
  assert.equal((await request(fixture.manager)).status, 200); assert.equal((await request(foreign)).status, 404);
  assert.equal((await request(foreign, { method: 'POST', body })).status, 404);
  for (const extra of [{ csrf: null }, { csrf: foreign.csrfToken }, { origin: 'https://foreign.invalid' }]) {
    assert.equal((await request(fixture.manager, { method: 'POST', body, ...extra })).status, 403);
  }
  assert.equal((await request(fixture.manager, { method: 'POST', body })).body.replayed, true);
  const finalPage = await request(fixture.manager, { path: `${root}?orderVersion=1&afterSequence=20` });
  assert.equal(finalPage.status, 200); assert.equal(finalPage.body.events[0].sequence, 21);
  const unqueued = await fixture.createApprovedOrder(3);
  await assert.rejects(service.record(command(unqueued.order.orderId, 3)), /SOURCE_UNAVAILABLE/);
  const late = await fixture.createApprovedOrder(2, { quoteExpiresAt: new Date(Date.now() + 3000).toISOString() });
  await delivery.enqueue({ ...fixture.context(), schemaVersion: 1, orderId: late.order.orderId,
    expectedOrderVersion: 1, expectedStateRevision: 3, expectedQuoteRevision: 1 });
  const lateFact = command(late.order.orderId);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.equal((await fixture.orders.load({ ...fixture.context(), orderId: late.order.orderId })).quote.expired, true);
  assert.equal((await service.record(lateFact)).orderState.status, 'transmitted');
  const second = await queued(1); const other = command(second.order.orderId);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
    [fixture.tenantId,fixture.manager.principal.session.id]);
  await assert.rejects(service.record(other), /PRINCIPAL_NOT_AUTHORIZED/);
  assert.equal((await request(fixture.manager)).status, 401);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_manual_delivery_facts')).rows[0].n, 22);
  await pool.query('TRUNCATE catering_manual_delivery_heads,catering_manual_delivery_facts');
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catalogue source grants020.
  await rollbackLatestDemoMigration(pool, { roles }); // Platform passkey reset grants019 before schema053.
  await rollbackLatestDemoMigration(pool, { roles }); // Unsent grants018 before schema052.
  await rollbackLatestDemoMigration(pool, { roles }); // Revoke017 before recreating051.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty051; retained050 audit still blocks rollback.
  await assert.rejects(rollbackLatest(pool), /CATERING_MANUAL_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const renewed = await fixture.sessionService.issue({ tenantId: fixture.tenantId, userId: id(20),
    roles: ['conference_manager'], permissions: ['request:manage'], securityVersion: 1,
    providerIdentity: { provider: 'test_identity', reference: 'synthetic-renewed' } }, { correlationId: id(90) });
  assert.equal((await service.record({ ...other, ...fixture.context(renewed) })).orderState.status, 'transmitted');
  await pool.query('UPDATE users SET security_version=security_version+1 WHERE tenant_id=$1 AND id=$2',
    [fixture.tenantId,id(20)]);
  await assert.rejects(service.record({ ...other, ...fixture.context(renewed) }), /PRINCIPAL_NOT_AUTHORIZED/);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_manual_delivery_facts')).rows[0].n, 1);
  const reset = createPostgresDemoResetRepository({ pool: resetPool, expectedDatabaseName: name, expectedResetRole: roles.reset });
  assert.equal((await reset.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM })).checksum, DEMO_FIXTURE_CHECKSUM);
  for (const table of ['catering_manual_delivery_facts','catering_manual_delivery_heads']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n, 0);
  }
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catalogue source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Platform passkey reset grants019 before schema053.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Unsent grants018 before schema052.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Version grants017.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true);
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version schema051.
  assert.equal(await rollbackLatest(pool), true);
  await migrateUp(pool); await migrateDemoUp(pool, { roles }); assert.equal(await isPostgresSchemaReady(pool), true);
});
