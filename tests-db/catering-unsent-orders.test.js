import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringOrderService } from '../src/application/catering-order-service.js';
import { createCateringDeliveryService } from '../src/application/catering-delivery-service.js';
import { createCateringManualDeliveryService } from '../src/application/catering-manual-delivery-service.js';
import { createCateringWithdrawalService } from '../src/application/catering-withdrawal-service.js';
import { createCateringVersionService } from '../src/application/catering-version-service.js';
import { createCateringJobProcessor } from '../src/application/catering-job-processor.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createProviderRegistry } from '../src/integrations/provider-registry.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringDeliveryRouteModules } from '../src/catering-delivery-composition.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createPostgresCateringOrderRepository } from '../src/persistence/postgres/catering-order-repository.js';
import { createPostgresCateringDeliveryRepository } from '../src/persistence/postgres/catering-delivery-repository.js';
import { createPostgresCateringManualDeliveryRepository } from '../src/persistence/postgres/catering-manual-delivery-repository.js';
import { createPostgresCateringWithdrawalRepository } from '../src/persistence/postgres/catering-withdrawal-repository.js';
import { createPostgresCateringVersionRepository } from '../src/persistence/postgres/catering-version-repository.js';
import { createPostgresCateringJobRepository } from '../src/persistence/postgres/catering-job-repository.js';
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
test('actual Customer withdrawal preserves history, fences active delivery and resets under restricted roles', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_unsent_${process.pid}`;
  const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key, `cm_unsent_${key}_${process.pid}`]));
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
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catalogue source grants020.
  await rollbackLatestDemoMigration(pool, { roles }); // Passkey reset grants019.
  await rollbackLatestDemoMigration(pool, { roles }); // Unsent grants018 while canonical053 is still ready.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty passkey storage053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent storage052.
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const manualRegistry = createCateringConfigurationRegistry(); let currentRegistry = manualRegistry;
  const registry = { get: (providerId) => currentRegistry.get(providerId) };
  const fixture = await createCateringDeliveryFixture(pool, { registry });
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
  const customer = rolePool(roles.customer); const resetPool = rolePool(roles.reset);
  const authorizationPolicy = createAuthorizationPolicy();
  const dependencies = { registry: fixture.registry, auditRepository: fixture.auditRepository };
  const application = { authorizationPolicy, auditService: fixture.auditService };
  const orders = createCateringOrderService({ ...application, registry: fixture.registry,
    repository: createPostgresCateringOrderRepository(customer, dependencies) });
  const delivery = createCateringDeliveryService({ ...application,
    repository: createPostgresCateringDeliveryRepository(customer, dependencies) });
  const manual = createCateringManualDeliveryService({ ...application,
    repository: createPostgresCateringManualDeliveryRepository(customer, dependencies) });
  const make = (auditRepository = fixture.auditRepository) => createCateringWithdrawalService({ ...application,
    repository: createPostgresCateringWithdrawalRepository(customer, { registry: fixture.registry, auditRepository }) });
  const withdrawals = make(); const context = fixture.context(); let sequence = 5000;
  const load = (orderId) => orders.load({ ...context, orderId });
  const command = (view) => ({ ...context, schemaVersion: 1, commandId: id(sequence++), orderId: view.order.orderId,
    expectedOrderVersion: view.order.orderVersion, expectedStateRevision: view.state.revision,
    justification: 'Synthetic local stop', attestNotTransmitted: true });
  const enqueue = async (view) => {
    await delivery.enqueue({ ...context, schemaVersion: 1, orderId: view.order.orderId, expectedOrderVersion: view.order.orderVersion,
      expectedStateRevision: view.state.revision, expectedQuoteRevision: view.quote.revision }); return load(view.order.orderId);
  };
  const privileges = (await pool.query(`SELECT
    has_table_privilege($1,'catering_order_withdrawals','INSERT') AS append,
    has_table_privilege($1,'catering_order_withdrawals','UPDATE') AS mutate,
    has_table_privilege($2,'catering_order_withdrawals','SELECT') AS platform,
    has_table_privilege($3,'catering_order_withdrawals','TRUNCATE') AS reset`,
  [roles.customer,roles.platform,roles.reset])).rows[0];
  assert.deepEqual(privileges, { append: true, mutate: false, platform: false, reset: true });
  await assert.rejects(rolePool(roles.platform).query('SELECT * FROM catering_order_withdrawals'), (error) => error.code === '42501');
  const prepared = await fixture.createPreparedOrder(); const original = JSON.stringify(prepared.order); const first = command(prepared);
  const concurrent = await Promise.all([withdrawals.withdraw(first),withdrawals.withdraw(first)]);
  assert.deepEqual(concurrent.map((value) => value.replayed).sort(), [false,true]);
  const stopped = await load(prepared.order.orderId);
  assert.equal(stopped.state.status, 'withdrawn'); assert.equal(stopped.quote, null);
  assert.equal(JSON.stringify(stopped.order), original);
  assert.equal((await withdrawals.load({ ...context, orderId: prepared.order.orderId })).eligible, false);
  await assert.rejects(withdrawals.withdraw({ ...first, justification: 'Changed command' }), /COMMAND_CONFLICT/);
  await assert.rejects(orders.recordQuote({ ...context, schemaVersion: 1, orderId: stopped.order.orderId,
    expectedOrderVersion: 1, expectedStateRevision: 2, expectedQuoteRevision: 0, cost: { amountMinor: 0, currency: 'EUR' },
    expiresAt: new Date(Date.now() + 3600000).toISOString() }), /DELIVERY_IN_PROGRESS/);
  await assert.rejects(customer.query(`UPDATE catering_order_version_states SET revision=revision+1,status='pending_quote'
    WHERE tenant_id=$1 AND order_id=$2`, [fixture.tenantId,prepared.order.orderId]), /CATERING_WITHDRAWN_VERSION_IMMUTABLE/);
  const released = await fixture.createApprovedOrder(1); const rollbackCommand = command(released);
  await assert.rejects(make({ async appendWithClient() { throw new Error('SYNTHETIC_WITHDRAWAL_AUDIT_FAILURE'); } })
    .withdraw(rollbackCommand), /SYNTHETIC_WITHDRAWAL_AUDIT_FAILURE/);
  assert.equal((await load(released.order.orderId)).state.status, 'released');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_order_withdrawals')).rows[0].n, 1);
  const queued = await enqueue(await fixture.createApprovedOrder(2));
  const jobs = createPostgresCateringJobRepository(customer, { ...dependencies, auditService: fixture.auditService });
  assert.deepEqual(await jobs.claimNext(), { kind: 'resolved', status: 'deferred' });
  await withdrawals.withdraw(command(queued));
  const superseded = (await delivery.list({ ...context, orderId: queued.order.orderId })).jobs[0];
  assert.equal(superseded.status, 'superseded'); assert.equal(superseded.dispatchAttempts, 0);
  assert.equal(await jobs.claimNext(), null);
  const leased = await enqueue(await fixture.createApprovedOrder(3));
  // Controlled authoritative lease-state setup, not a claim of supplier I/O.
  await customer.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='leased',lease_id=$3,
    lease_expires_at=clock_timestamp()+interval '1 hour',available_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND order_id=$2`, [fixture.tenantId,leased.order.orderId,id(8000)]);
  await assert.rejects(withdrawals.withdraw(command(leased)), /SOURCE_UNAVAILABLE/);
  await assert.rejects(customer.query(`INSERT INTO catering_order_withdrawals
    (tenant_id,order_id,order_version,command_id,origin_state_revision,previous_status,prior_quote_revision,prior_decision_sequence,
      job_id,job_revision,justification,recorded_by_user_id,actor_security_version,correlation_id,attest_not_transmitted)
    SELECT tenant_id,order_id,order_version,$3,4,'queued',quote_revision,decision_sequence,id,revision,
      'Synthetic attempted bypass',$4,1,$5,true FROM catering_delivery_jobs WHERE tenant_id=$1 AND order_id=$2`,
  [fixture.tenantId,leased.order.orderId,id(sequence++),id(20),id(90)]), /CATERING_WITHDRAWAL_DELIVERY_STARTED/);
  const sent = await enqueue(await fixture.createApprovedOrder(4));
  await manual.record({ ...context, schemaVersion: 1, orderId: sent.order.orderId, commandId: id(sequence++),
    expectedOrderVersion: 1, expectedStateRevision: sent.state.revision, kind: 'transmitted', channel: 'telephone',
    reference: 'Synthetic physical transmission', occurredAt: new Date().toISOString(), receipt: null });
  await assert.rejects(withdrawals.withdraw(command(await load(sent.order.orderId))), /SOURCE_UNAVAILABLE/);
  const versions = createCateringVersionService({ ...application,
    repository: createPostgresCateringVersionRepository(customer, dependencies) });
  const replacementContext = await versions.load({ ...context, orderId: stopped.order.orderId });
  assert.equal(replacementContext.basis, null); assert.deepEqual(replacementContext.allowedOperations, ['change']);
  const replacementCommand = { ...context, schemaVersion: 1, commandId: id(sequence++), orderId: stopped.order.orderId,
    expectedOrderVersion: 1, expectedStateRevision: 2, expectedRequestVersion: 1, expectedAssignmentRevision: 1,
    operation: 'change', justification: 'Synthetic new first physical order' };
  const proposed = await versions.propose(replacementCommand);
  assert.equal(proposed.replayed, false);
  assert.equal((await versions.propose(replacementCommand)).replayed, true);
  let replacement = await load(stopped.order.orderId);
  assert.equal(replacement.schemaVersion, 2); assert.equal(replacement.operation, 'change');
  assert.equal(replacement.deliveryOperation, 'initial'); assert.equal(replacement.order.orderVersion, 2);
  assert.equal(replacement.quote, null); assert.equal(replacement.decision, null);
  assert.equal(replacement.state.status, 'pending_quote');
  await assert.rejects(orders.recordQuote({ ...context, schemaVersion: 1, orderId: replacement.order.orderId,
    expectedOrderVersion: 1, expectedStateRevision: 1, expectedQuoteRevision: 0, cost: { amountMinor: 1300, currency: 'EUR' },
    expiresAt: new Date(Date.now() + 3600000).toISOString() }), /REVISION_CONFLICT/);
  replacement = await orders.recordQuote({ ...context, schemaVersion: 1, orderId: replacement.order.orderId,
    expectedOrderVersion: 2, expectedStateRevision: 1, expectedQuoteRevision: 0, cost: { amountMinor: 1300, currency: 'EUR' },
    expiresAt: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(replacement.state.status, 'pending_manager_review');
  replacement = await orders.decide({ ...context, schemaVersion: 1, orderId: replacement.order.orderId,
    expectedOrderVersion: 2, expectedStateRevision: 2, expectedQuoteRevision: 1, decision: 'approved' });
  replacement = await enqueue(replacement);
  await manual.record({ ...context, schemaVersion: 1, orderId: replacement.order.orderId, commandId: id(sequence++),
    expectedOrderVersion: 2, expectedStateRevision: replacement.state.revision, kind: 'transmitted', channel: 'telephone',
    reference: 'Synthetic first physical replacement', occurredAt: new Date().toISOString(), receipt: null });
  replacement = await load(replacement.order.orderId);
  await manual.record({ ...context, schemaVersion: 1, orderId: replacement.order.orderId, commandId: id(sequence++),
    expectedOrderVersion: 2, expectedStateRevision: replacement.state.revision, kind: 'receipt', channel: 'telephone',
    reference: 'Synthetic complete replacement receipt', occurredAt: new Date().toISOString(), receipt: {
      orderId: replacement.order.orderId, orderVersion: 2,
      positions: replacement.order.positions.map((position) => ({ positionId: position.positionId, outcome: 'confirmed' })),
    } });
  assert.equal((await versions.load({ ...context, orderId: replacement.order.orderId })).basis.orderVersion, 2);
  const history = await orders.load({ ...context, orderId: stopped.order.orderId, orderVersion: 1 });
  assert.equal(history.state.status, 'withdrawn'); assert.equal(history.quote, null);
  assert.equal(JSON.stringify(history.order), original);
  assert.equal((await withdrawals.load({ ...context, orderId: stopped.order.orderId, orderVersion: 1 })).effective.orderVersion, 2);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_unsent_replacements')).rows[0].n, 1);
  // Park prior manual work before admitting the isolated synthetic API replacement.
  for (let admission = 0; admission < 3; admission++) {
    const result = await jobs.claimNext(); if (result === null) break;
    assert.deepEqual(result, { kind: 'resolved', status: 'deferred' });
  }
  assert.equal(await jobs.claimNext(), null);
  let automatic = await fixture.createPreparedOrder(10);
  await withdrawals.withdraw(command(automatic));
  await versions.propose({ ...replacementCommand, commandId: id(sequence++), orderId: automatic.order.orderId });
  automatic = await orders.recordQuote({ ...context, schemaVersion: 1, orderId: automatic.order.orderId,
    expectedOrderVersion: 2, expectedStateRevision: 1, expectedQuoteRevision: 0, cost: { amountMinor: 1400, currency: 'EUR' },
    expiresAt: new Date(Date.now() + 3600000).toISOString() });
  automatic = await orders.decide({ ...context, schemaVersion: 1, orderId: automatic.order.orderId,
    expectedOrderVersion: 2, expectedStateRevision: 2, expectedQuoteRevision: 1, decision: 'approved' });
  automatic = await enqueue(automatic);
  // Controlled descriptor only: real Admin CAS disables before changing modes.
  // No production API supplier registration, qualification or external I/O.
  await fixture.setOrderCapability(false);
  currentRegistry = createProviderRegistry({ runtime: 'production', descriptors: [{ id: 'manual_catering', runtime: 'production',
    capabilities: { 'catering.order': 'api', 'catering.status': 'api' } }] });
  await fixture.setOrderCapability(true, 'api');
  const lease = await jobs.claimNext(); assert.equal(lease.job.orderId, automatic.order.orderId);
  assert.equal(lease.job.operation, 'change'); assert.equal(lease.deliveryOperation, 'initial');
  assert.equal(await jobs.beginDispatch({ ...lease, deliveryOperation: 'change' }), null);
  const calls = [];
  const provider = {
    async placeOrder(input) { calls.push(['place', input]); throw new Error('Synthetic uncertain transport'); },
    async readOrderStatus(input) {
      calls.push(['read', input]); return { orderId: input.orderId, orderVersion: input.orderVersion,
        positions: automatic.order.positions.map((position) => ({ positionId: position.positionId, outcome: 'confirmed' })) };
    },
  };
  let claimed = false;
  const processor = (repository) => createCateringJobProcessor({ repository, registry, providers: { resolve: () => provider } });
  const dispatched = await processor({ ...jobs, async claimNext() { if (claimed) return null; claimed = true; return lease; } })
    .runBatch({ limit: 1, signal: new AbortController().signal });
  assert.equal(dispatched.reconciliationCount, 1);
  assert.equal((await load(automatic.order.orderId)).state.status, 'reconciliation_required');
  await assert.rejects(withdrawals.withdraw(command(await load(automatic.order.orderId))), /SOURCE_UNAVAILABLE/);
  // Advance only persisted read admission, preserving unknown outcome and write count.
  await customer.query(`UPDATE catering_delivery_jobs SET revision=revision+1,available_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE tenant_id=$1 AND order_id=$2 AND status='reconciliation_required'`,
  [fixture.tenantId,automatic.order.orderId]);
  assert.equal((await processor(jobs).runBatch({ limit: 1, signal: new AbortController().signal })).completedCount, 1);
  assert.deepEqual(calls.map(([method]) => method), ['place','read']);
  assert.equal(calls[0][1].operation, 'initial'); assert.equal(calls[1][1].operation, 'initial');
  assert.equal(calls[0][1].idempotencyKey, calls[1][1].idempotencyKey);
  assert.equal(Object.hasOwn(calls[1][1], 'order'), false);
  assert.equal((await load(automatic.order.orderId)).state.status, 'confirmed');
  assert.equal((await customer.query(`SELECT dispatch_attempts FROM catering_delivery_jobs
    WHERE tenant_id=$1 AND order_id=$2`, [fixture.tenantId,automatic.order.orderId])).rows[0].dispatch_attempts, 1);
  await fixture.setOrderCapability(false); currentRegistry = manualRegistry; await fixture.setOrderCapability(true);
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN,
    CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' });
  const modules = createCateringDeliveryRouteModules({ config, ...application,
    persistence: { pool: customer, auditRepository: fixture.auditRepository } });
  const tenants = createPostgresTenantRepository(pool);
  const server = createHttpServer({ config, ...application, additionalRouteModules: modules, sessionService: fixture.sessionService,
    loadTenant: (tenantId) => tenants.findById(tenantId),
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const root = `/api/v1/tenant/catering/orders/${released.order.orderId}/withdrawal`;
  function request(actor, { method = 'GET', csrf = actor?.csrfToken, origin = ORIGIN, body } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: root, headers: {
        Host: new URL(ORIGIN).host, Origin: origin, ...(actor ? { Cookie: actor.setCookie.split(';',1)[0] } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      } }, (response) => {
        const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
      outgoing.on('error', reject); outgoing.end(body);
    });
  }
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Foreign synthetic Tenant','active')", [id(50)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Foreign synthetic Manager')", [id(50),id(20)]);
  const foreign = await fixture.sessionService.issue({ tenantId: id(50), userId: id(20), roles: ['conference_manager'],
    permissions: ['request:manage'], securityVersion: 1,
    providerIdentity: { provider: 'test_identity', reference: 'synthetic-withdrawal-foreign' } }, { correlationId: id(90) });
  const { principal: _principal, tenantContext: _tenant, correlationId: _correlation, orderId: _order, ...wire } = rollbackCommand;
  const body = JSON.stringify(wire);
  assert.equal((await request()).status, 401); assert.equal((await request(fixture.admin)).status, 403);
  assert.equal((await request(foreign)).status, 404); assert.equal((await request(foreign, { method: 'POST', body })).status, 404);
  for (const extra of [{ csrf: null }, { csrf: foreign.csrfToken }, { origin: 'https://foreign.invalid' }]) {
    assert.equal((await request(fixture.manager, { method: 'POST', body, ...extra })).status, 403);
  }
  const committed = await request(fixture.manager, { method: 'POST', body });
  assert.equal(committed.status, 200); assert.equal(committed.body.orderState.status, 'withdrawn');
  assert.equal((await request(fixture.manager, { method: 'POST', body })).body.replayed, true);
  assert.equal((await request(fixture.manager)).body.withdrawal.previousStatus, 'released');
  assert.equal(await fixture.auditRepository.verifyTenantChain(fixture.tenantId), true);
  const audited = await pool.query("SELECT metadata,new_state FROM audit_events WHERE action='catering.order.withdrawn'");
  assert.doesNotMatch(JSON.stringify(audited.rows), /Synthetic local|justification|amountMinor|jobId|sessionId/);
  for (const sql of ['UPDATE catering_order_withdrawals SET justification=justification','DELETE FROM catering_order_withdrawals']) {
    await assert.rejects(customer.query(sql), (error) => error.code === '42501');
    await assert.rejects(pool.query(sql), /CATERING_ORDER_HISTORY_APPEND_ONLY/);
  }
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catalogue source grants020.
  await rollbackLatestDemoMigration(pool, { roles }); // Remove grants019 before empty053.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Exercise the unchanged052 rollback guard below.
  await assert.rejects(rollbackLatest(pool), /CATERING_UNSENT_ROLLBACK_REQUIRES_REVIEW/);
  await pool.query(`TRUNCATE catering_unsent_replacements,catering_order_withdrawals,catering_version_proposals,
    catering_manual_delivery_heads,
    catering_manual_delivery_facts,catering_delivery_observations,catering_delivery_attempts,catering_delivery_jobs,
    catering_order_version_states,catering_order_decisions,catering_order_quotes,catering_order_heads,catering_order_version_seals,
    catering_order_positions,catering_order_versions,catering_orders`);
  await assert.rejects(rollbackLatest(pool), /CATERING_UNSENT_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool); await migrateDemoUp(pool, { roles }); // Restore exact053/019 before runtime/reset.
  const resetSource = await fixture.createPreparedOrder(100); await withdrawals.withdraw(command(resetSource));
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_order_withdrawals')).rows[0].n, 1);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
    [fixture.tenantId,fixture.manager.principal.session.id]);
  await assert.rejects(withdrawals.withdraw(first), /PRINCIPAL_NOT_AUTHORIZED/);
  assert.equal((await request(fixture.manager)).status, 401);
  const reset = createPostgresDemoResetRepository({ pool: resetPool, expectedDatabaseName: name, expectedResetRole: roles.reset });
  assert.equal((await reset.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM })).checksum, DEMO_FIXTURE_CHECKSUM);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_order_withdrawals')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_unsent_replacements')).rows[0].n, 0);
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Catalogue source grants020.
  await rollbackLatestDemoMigration(pool, { roles }); //019 before changing canonical readiness.
  await rollbackLatestDemoMigration(pool, { roles }); //018 before changing canonical readiness.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  await rollbackLatest(pool); await rollbackLatest(pool); // Empty053 and052.
  await migrateUp(pool); await migrateDemoUp(pool, { roles }); assert.equal(await isPostgresSchemaReady(pool), true);
});
