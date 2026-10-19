import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringOrderService } from '../src/application/catering-order-service.js';
import { createCateringDeliveryService } from '../src/application/catering-delivery-service.js';
import { createCateringManualDeliveryService } from '../src/application/catering-manual-delivery-service.js';
import { createCateringVersionService } from '../src/application/catering-version-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringDeliveryRouteModules } from '../src/catering-delivery-composition.js';
import { createCateringOrderRouteModules } from '../src/catering-order-composition.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { normalizeRequest } from '../src/domain/request.js';
import { createPostgresCateringOrderRepository } from '../src/persistence/postgres/catering-order-repository.js';
import { createPostgresCateringDeliveryRepository } from '../src/persistence/postgres/catering-delivery-repository.js';
import { createPostgresCateringManualDeliveryRepository } from '../src/persistence/postgres/catering-manual-delivery-repository.js';
import { createPostgresCateringVersionRepository } from '../src/persistence/postgres/catering-version-repository.js';
import { loadCateringOrderSourceWithClient } from '../src/persistence/postgres/catering-order-source.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { appendRequestRevisionWithClient } from '../src/persistence/postgres/request-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { createHttpServer } from '../src/server.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { migrateDemoUp, rollbackLatestDemoMigration } from '../scripts/demo-db-migrations.mjs';
import { createCateringDeliveryFixture } from './support/catering-delivery-fixture.js';
import { cateringId as id, cateringOrderFixture } from '../tests/support/catering-order-fixture.js';

const ORIGIN = 'http://localhost:3000';
test('actual Customer reviewed versions retain the confirmed order until replacement or cancellation receipt', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_versions_${process.pid}`;
  const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key, `cm_versions_${key}_${process.pid}`]));
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
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Passkey reset grants019.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Unsent grants018.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true);
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const fixture = await createCateringDeliveryFixture(pool, { extraCount: 1, reviewOperations: true });
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
  const dependencies = { registry: fixture.registry, auditRepository: fixture.auditRepository };
  const application = { authorizationPolicy, auditService: fixture.auditService };
  const orders = createCateringOrderService({ ...application, registry: fixture.registry,
    repository: createPostgresCateringOrderRepository(customer, dependencies) });
  const delivery = createCateringDeliveryService({ ...application,
    repository: createPostgresCateringDeliveryRepository(customer, dependencies) });
  const facts = createCateringManualDeliveryService({ ...application,
    repository: createPostgresCateringManualDeliveryRepository(customer, dependencies) });
  const make = (auditRepository = fixture.auditRepository) => createCateringVersionService({ ...application,
    repository: createPostgresCateringVersionRepository(customer, { registry: fixture.registry, auditRepository }) });
  const versions = make();
  const privileges = (await pool.query(`SELECT
    has_table_privilege($1,'catering_version_proposals','INSERT') AS append,
    has_table_privilege($1,'catering_version_proposals','UPDATE') AS mutate,
    has_table_privilege($2,'catering_version_proposals','SELECT') AS platform,
    has_table_privilege($3,'catering_version_proposals','TRUNCATE') AS reset,
    has_function_privilege($1,'catering_order_source_current(uuid,uuid,bigint)','EXECUTE') AS customer_source,
    has_function_privilege($2,'catering_order_source_current(uuid,uuid,bigint)','EXECUTE') AS platform_source`,
  [roles.customer,roles.platform,roles.reset])).rows[0];
  assert.deepEqual(privileges, { append: true, mutate: false, platform: false, reset: true,
    customer_source: true, platform_source: false });
  await assert.rejects(rolePool(roles.platform).query('SELECT * FROM catering_version_proposals'), (error) => error.code === '42501');
  let sequence = 3000;
  const context = fixture.context();
  const load = (orderId, orderVersion = null) => orders.load({ ...context, orderId, orderVersion });
  const versionContext = (orderId, afterOrderVersion = 1) => versions.load({ ...context, orderId, afterOrderVersion });
  const proposed = async (orderId, operation = 'exception', justification = 'Synthetic supplier cost review') => {
    const page = await versionContext(orderId);
    return { ...context, schemaVersion: 1, orderId, commandId: id(sequence++),
      expectedOrderVersion: page.orderState.orderVersion, expectedStateRevision: page.orderState.revision,
      expectedRequestVersion: page.currentRequest.version,
      expectedAssignmentRevision: operation === 'change' ? page.currentAssignmentRevision : page.basis.assignmentRevision,
      operation, justification };
  };
  async function quote(view, amountMinor = 1200) {
    return orders.recordQuote({ ...context, schemaVersion: 1, orderId: view.order.orderId,
      expectedOrderVersion: view.order.orderVersion, expectedStateRevision: view.state.revision,
      expectedQuoteRevision: view.quote?.revision ?? 0, cost: { amountMinor, currency: 'EUR' },
      expiresAt: new Date(Date.now() + 3600000).toISOString() });
  }
  async function decide(view, decision = 'approved') {
    return orders.decide({ ...context, schemaVersion: 1, orderId: view.order.orderId, expectedOrderVersion: view.order.orderVersion,
      expectedStateRevision: view.state.revision, expectedQuoteRevision: view.quote.revision, decision });
  }
  async function receipt(view, outcomes) {
    await facts.record({ ...context, schemaVersion: 1, orderId: view.order.orderId, commandId: id(sequence++),
      expectedOrderVersion: view.order.orderVersion, expectedStateRevision: view.state.revision, kind: 'receipt',
      channel: 'telephone', reference: 'Synthetic supplier response', occurredAt: new Date().toISOString(),
      receipt: { orderId: view.order.orderId, orderVersion: view.order.orderVersion,
        positions: view.order.positions.map((line, index) => ({ positionId: line.positionId, outcome: outcomes[index] })) } });
    return load(view.order.orderId);
  }
  async function transmit(view) {
    await delivery.enqueue({ ...context, schemaVersion: 1, orderId: view.order.orderId, expectedOrderVersion: view.order.orderVersion,
      expectedStateRevision: view.state.revision, expectedQuoteRevision: view.quote.revision });
    const queued = await load(view.order.orderId);
    await facts.record({ ...context, schemaVersion: 1, orderId: view.order.orderId, commandId: id(sequence++),
      expectedOrderVersion: view.order.orderVersion, expectedStateRevision: queued.state.revision, kind: 'transmitted',
      channel: 'telephone', reference: 'Synthetic supplier transmission', occurredAt: new Date().toISOString(), receipt: null });
    return load(view.order.orderId);
  }
  const initial = await fixture.createApprovedOrder(); const orderId = initial.order.orderId;
  assert.deepEqual((await versionContext(orderId)).allowedOperations, []);
  await assert.rejects(versions.propose({ ...context, schemaVersion: 1, orderId, commandId: id(sequence++),
    expectedOrderVersion: 1, expectedStateRevision: 3, expectedRequestVersion: 1, expectedAssignmentRevision: 1,
    operation: 'exception', justification: 'Synthetic unresolved initial order' }), /SOURCE_UNAVAILABLE/);
  const original = await receipt(await transmit(initial), ['confirmed','confirmed']);
  const originalSnapshot = JSON.stringify(original.order);
  assert.equal((await versionContext(orderId)).basis.orderVersion, 1);
  // All overlays require exact runtime readiness; revoke019/018/017 before canonical rollback.
  await rollbackLatestDemoMigration(pool, { roles }); //019.
  await rollbackLatestDemoMigration(pool, { roles }); await rollbackLatestDemoMigration(pool, { roles }); //018/017.
  await rollbackLatest(pool); // Empty053 above the historical052/051 rollback probe.
  await rollbackLatest(pool); // Empty052 above the original051 rollback probe.
  // Canonical051 can roll back empty while preserving existing050 physical facts.
  await rollbackLatest(pool);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_manual_delivery_facts')).rows[0].n, 2);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  // A complete-looking version without reviewed proposal evidence still cannot seal.
  await assert.rejects(withPostgresTransaction(customer, async (client) => {
    await client.query(`INSERT INTO catering_order_versions
      (tenant_id,order_id,version,request_id,request_version,integration_id,assignment_revision,catalogue_revision,
        configuration_revision,operation,position_count,conference_total_minor,currency,created_at,created_by_user_id,correlation_id)
      SELECT tenant_id,order_id,2,request_id,request_version,integration_id,assignment_revision,catalogue_revision,
        configuration_revision,'exception',position_count,conference_total_minor,currency,
        clock_timestamp(),created_by_user_id,correlation_id
      FROM catering_order_versions WHERE tenant_id=$1 AND order_id=$2 AND version=1`, [fixture.tenantId,orderId]);
    await client.query(`INSERT INTO catering_order_positions(tenant_id,order_id,version,position_id,kind,entry_id)
      SELECT tenant_id,order_id,2,position_id,kind,entry_id FROM catering_order_positions
      WHERE tenant_id=$1 AND order_id=$2 AND version=1`, [fixture.tenantId,orderId]);
    await client.query(`INSERT INTO catering_order_version_states(tenant_id,order_id,version,revision,status,updated_at)
      VALUES ($1,$2,2,1,'pending_quote',clock_timestamp())`, [fixture.tenantId,orderId]);
    await client.query('UPDATE catering_order_heads SET current_version=2 WHERE tenant_id=$1 AND order_id=$2',
      [fixture.tenantId,orderId]);
  }), /CATERING_VERSION_PROPOSAL_REQUIRED/);
  assert.equal((await versionContext(orderId)).orderState.orderVersion, 1);
  let currentRequest = (await withPostgresTransaction(pool, (client) => loadCateringOrderSourceWithClient(client,
    { tenantId: fixture.tenantId, requestId: original.order.requestId, requestVersion: 1, assignmentRevision: 1 }))).request;
  async function replaceConference(status = 'Confirmed') {
    const now = new Date().toISOString(); const nextVersion = currentRequest.version + 1;
    const source = status === 'Confirmed' ? cateringOrderFixture({ requestVersion: nextVersion, catalogueRevision: 2,
      extraCount: 1, includedSelection: false, capturedAt: now,
      startsAt: new Date(Date.parse(currentRequest.startsAt) + 3600000).toISOString() }).request : currentRequest;
    const next = normalizeRequest({ ...source, id: currentRequest.id, version: nextVersion, status,
      requesterAttribution: currentRequest.requesterAttribution, createdAt: currentRequest.createdAt, updatedAt: now,
      statusChangedAt: status === 'Cancelled' ? now : currentRequest.statusChangedAt,
      // Canonical Request cancellation has no statusReason; supplier justification
      // belongs to the separate reviewed cancellation proposal below.
      statusReason: null,
      snapshot: { ...source.snapshot, requestVersion: nextVersion } });
    const employee = status === 'Cancelled';
    const event = fixture.auditService.createEvent({ ...context,
      principal: employee ? { tenantId: fixture.tenantId, userId: id(2) } : context.principal,
      action: employee ? 'request.transition' : 'request.booking_change', targetType: 'request', targetId: currentRequest.id,
      previousState: { version: currentRequest.version, status: currentRequest.status },
      newState: { version: next.version, status: next.status }, outcome: 'success', retentionClass: 'business' });
    // Controlled synthetic conference source only. Supplier/business commands below
    // use the actual Customer role and real session/audit/HTTP services.
    await withPostgresTransaction(pool, async (client) => {
      await client.query(`UPDATE requests SET request_version=$3,status=$4,status_reason=$5,starts_at=$6,ends_at=$7,
        internal_participants=$8,external_participants=$9,request_snapshot=$10::jsonb,status_changed_at=$11,updated_at=$12
        WHERE tenant_id=$1 AND id=$2`, [fixture.tenantId,next.id,next.version,next.status,next.statusReason,next.startsAt,next.endsAt,
        next.internalParticipants,next.externalParticipants,JSON.stringify(next.snapshot),next.statusChangedAt,next.updatedAt]);
      await appendRequestRevisionWithClient(client, next, employee ? 'transitioned' : 'booking_changed', event,
        employee ? 'employee' : 'conference_manager');
      await fixture.auditRepository.appendWithClient(client, event);
    });
    currentRequest = next;
  }
  await replaceConference();
  const command = await proposed(orderId, 'change', 'Synthetic changed conference schedule');
  await assert.rejects(make({ async appendWithClient() { throw new Error('SYNTHETIC_VERSION_AUDIT_FAILURE'); } }).propose(command),
    /SYNTHETIC_VERSION_AUDIT_FAILURE/);
  assert.equal((await versionContext(orderId)).orderState.orderVersion, 1);
  const concurrent = await Promise.all([versions.propose(command),versions.propose(command)]);
  assert.deepEqual(concurrent.map((value) => value.replayed).sort(), [false,true]);
  assert.equal(concurrent[0].proposal.orderVersion, 2);
  assert.equal((await versionContext(orderId)).basis.orderVersion, 1);
  assert.equal(JSON.stringify((await load(orderId, 1)).order), originalSnapshot);
  assert.equal((await load(orderId)).order.requestVersion, 2);
  assert.equal((await load(orderId)).state.status, 'pending_quote');
  await assert.rejects(versions.propose({ ...command, justification: 'Changed command' }), /COMMAND_CONFLICT/);
  const pending = await load(orderId);
  await assert.rejects(orders.recordQuote({ ...context, schemaVersion: 1, orderId, expectedStateRevision: 1, expectedQuoteRevision: 0,
    cost: { amountMinor: 0, currency: 'EUR' }, expiresAt: new Date(Date.now() + 3600000).toISOString() }), /REVISION_CONFLICT/);
  assert.equal((await load(orderId)).quote, null);
  const replacementQuote = await quote(pending, 1500);
  await assert.rejects(orders.decide({ ...context, schemaVersion: 1, orderId, expectedStateRevision: 2,
    expectedQuoteRevision: 1, decision: 'approved' }), /REVISION_CONFLICT/);
  const replacement = await receipt(await transmit(await decide(replacementQuote)), ['confirmed','confirmed']);
  assert.equal((await versionContext(orderId)).basis.orderVersion, 2);
  assert.equal(replacement.state.status, 'confirmed');
  const exception = await proposed(orderId);
  await versions.propose(exception);
  const rejectedQuote = await decide(await quote(await load(orderId), 1800), 'rejected');
  const revised = await quote(rejectedQuote, 1900);
  await assert.rejects(orders.decide({ ...context, schemaVersion: 1, orderId, expectedOrderVersion: 3,
    expectedStateRevision: revised.state.revision, expectedQuoteRevision: 1, decision: 'approved' }), /QUOTE_UNAVAILABLE/);
  const partial = await receipt(await transmit(await decide(revised)), ['confirmed','substitution_proposed']);
  assert.equal(partial.state.status, 'partially_confirmed'); assert.equal((await versionContext(orderId)).basis.orderVersion, 2);
  await assert.rejects(versions.propose(await proposed(orderId)), /SOURCE_UNAVAILABLE/);
  const rejected = await receipt(partial, ['rejected','rejected']); assert.equal(rejected.state.status, 'rejected');
  await versions.propose(await proposed(orderId));
  const acceptedException = await receipt(await transmit(await decide(await quote(await load(orderId), 1900))), ['confirmed','confirmed']);
  assert.equal(acceptedException.order.orderVersion, 4); assert.equal((await versionContext(orderId)).basis.orderVersion, 4);
  assert.equal(acceptedException.order.conferencePrice.amountMinor, replacement.order.conferencePrice.amountMinor);
  for (let index = 0; index < 19; index++) {
    await versions.propose(await proposed(orderId, 'exception', `Synthetic unsent review ${index}`));
    await decide(await quote(await load(orderId), 1900), 'rejected');
  }
  const first = await versionContext(orderId); assert.equal(first.proposals.length, 20); assert.equal(first.nextAfterOrderVersion, 21);
  const tail = await versionContext(orderId, 21); assert.equal(tail.proposals.length, 2); assert.equal(tail.nextAfterOrderVersion, null);
  const beforeCancellation = await versionContext(orderId);
  await replaceConference('Cancelled');
  assert.equal((await load(orderId, 4)).state.status, 'confirmed');
  assert.equal((await versionContext(orderId)).basis.orderVersion, 4);
  assert.deepEqual((await versionContext(orderId)).allowedOperations, ['cancel']);
  const cancellation = await proposed(orderId, 'cancel', 'Synthetic whole conference cancellation review');
  await versions.propose(cancellation);
  const cancelPending = await load(orderId);
  assert.equal(cancelPending.order.requestVersion, 2); assert.equal((await versionContext(orderId)).basis.orderVersion, 4);
  assert.equal(cancelPending.state.status, 'pending_quote');
  const cancelled = await receipt(await transmit(await decide(await quote(cancelPending, 0))), ['confirmed','confirmed']);
  assert.equal(cancelled.state.status, 'cancelled');
  assert.equal((await versionContext(orderId)).basis.status, 'cancelled');
  assert.deepEqual((await versionContext(orderId)).allowedOperations, []);
  assert.equal((await versions.propose(command)).replayed, true);
  assert.equal(beforeCancellation.basis.orderVersion, 4);
  assert.equal(await fixture.auditRepository.verifyTenantChain(fixture.tenantId), true);
  const auditRows = await pool.query("SELECT metadata,new_state FROM audit_events WHERE action='catering.order.version_proposed'");
  assert.doesNotMatch(JSON.stringify(auditRows.rows), /justification|Synthetic changed|supplierPayload|sessionId/);
  for (const statement of ['UPDATE catering_version_proposals SET justification=justification','DELETE FROM catering_version_proposals']) {
    await assert.rejects(customer.query(statement), (error) => error.code === '42501');
    await assert.rejects(pool.query(statement), /CATERING_ORDER_HISTORY_APPEND_ONLY/);
  }
  await rollbackLatestDemoMigration(pool, { roles }); //019 while canonical053 is ready.
  await rollbackLatestDemoMigration(pool, { roles }); //018 while canonical053 is ready.
  await rollbackLatest(pool); // Empty053 above retained051.
  await rollbackLatest(pool); // Empty052 above retained051.
  await assert.rejects(rollbackLatest(pool), /CATERING_VERSION_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN,
    CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' });
  const composition = { config, persistence: { pool: customer, auditRepository: fixture.auditRepository }, ...application };
  const modules = [...createCateringOrderRouteModules(composition), ...createCateringDeliveryRouteModules(composition)];
  const tenants = createPostgresTenantRepository(pool);
  const server = createHttpServer({ config, additionalRouteModules: modules, ...application, sessionService: fixture.sessionService,
    loadTenant: (tenantId) => tenants.findById(tenantId),
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const root = `/api/v1/tenant/catering/orders/${orderId}`;
  function request(actor, { method = 'GET', path = `${root}/versions`, csrf = actor?.csrfToken, origin = ORIGIN, body } = {}) {
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
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Foreign synthetic Tenant','active')", [id(50)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Foreign synthetic Manager')", [id(50),id(20)]);
  const foreign = await fixture.sessionService.issue({ tenantId: id(50), userId: id(20), roles: ['conference_manager'],
    permissions: ['request:manage'], securityVersion: 1,
    providerIdentity: { provider: 'test_identity', reference: 'synthetic-version-foreign' } }, { correlationId: id(90) });
  const { principal: _principal, tenantContext: _tenant, correlationId: _correlation, orderId: _order, ...wire } = command;
  const body = JSON.stringify(wire);
  assert.equal((await request()).status, 401); assert.equal((await request(fixture.admin)).status, 403);
  assert.equal((await request(foreign)).status, 404); assert.equal((await request(foreign, { method: 'POST', body })).status, 404);
  for (const extra of [{ csrf: null }, { csrf: foreign.csrfToken }, { origin: 'https://foreign.invalid' }]) {
    assert.equal((await request(fixture.manager, { method: 'POST', body, ...extra })).status, 403);
  }
  assert.equal((await request(fixture.manager, { method: 'POST', body })).body.replayed, true);
  assert.equal((await request(fixture.manager, { path: `${root}?orderVersion=1` })).body.state.status, 'confirmed');
  const historic = await request(fixture.manager, { path: `${root}?orderVersion=2` });
  assert.equal(historic.status, 200); assert.equal(historic.body.order.orderVersion, 2);
  assert.equal((await request(fixture.manager, { path: `${root}/versions?afterOrderVersion=21` })).status, 200);
  await pool.query(`TRUNCATE catering_unsent_replacements,catering_order_withdrawals,catering_version_proposals,
    catering_manual_delivery_heads,catering_manual_delivery_facts,
    catering_delivery_observations,catering_delivery_attempts,catering_delivery_jobs,catering_order_version_states,
    catering_order_decisions,catering_order_quotes,catering_order_heads,catering_order_version_seals,catering_order_positions,
    catering_order_versions,catering_orders`);
  await rollbackLatestDemoMigration(pool, { roles }); //019 while canonical053 is ready.
  await rollbackLatestDemoMigration(pool, { roles }); //018 while canonical053 is ready.
  await rollbackLatest(pool); // Empty053 above retained051.
  await rollbackLatest(pool); // Empty052 above retained051.
  await assert.rejects(rollbackLatest(pool), /CATERING_VERSION_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const resetSource = await fixture.createApprovedOrder(100);
  await receipt(await transmit(resetSource), ['confirmed','confirmed']);
  await versions.propose(await proposed(resetSource.order.orderId));
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_version_proposals')).rows[0].n, 1);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
    [fixture.tenantId,fixture.manager.principal.session.id]);
  await assert.rejects(versions.propose(command), /PRINCIPAL_NOT_AUTHORIZED/);
  assert.equal((await request(fixture.manager)).status, 401);
  const reset = createPostgresDemoResetRepository({ pool: resetPool, expectedDatabaseName: name, expectedResetRole: roles.reset });
  assert.equal((await reset.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM })).checksum, DEMO_FIXTURE_CHECKSUM);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catering_version_proposals')).rows[0].n, 0);
  await rollbackLatestDemoMigration(pool, { roles }); //019 before canonical rollback.
  await rollbackLatestDemoMigration(pool, { roles }); await rollbackLatestDemoMigration(pool, { roles }); //018/017.
  await rollbackLatest(pool); // Empty053 before the original052/051 empty rollback probe.
  await rollbackLatest(pool); await rollbackLatest(pool);
  await migrateUp(pool); await migrateDemoUp(pool, { roles }); assert.equal(await isPostgresSchemaReady(pool), true);
});
