import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringCatalogueAssignmentService } from '../src/application/catering-catalogue-assignment-service.js';
import { createCateringOrderService } from '../src/application/catering-order-service.js';
import { createTenantCatalogueService } from '../src/application/tenant-catalogue-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringConfigurationRouteModules } from '../src/catering-configuration-composition.js';
import { createCateringOrderRouteModules } from '../src/catering-order-composition.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  createPostgresCateringCatalogueAssignmentRepository,
} from '../src/persistence/postgres/catering-catalogue-assignment-repository.js';
import { createPostgresCateringConfigurationRepository } from '../src/persistence/postgres/catering-configuration-repository.js';
import { createPostgresCateringOrderRepository } from '../src/persistence/postgres/catering-order-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { appendRequestRevisionWithClient } from '../src/persistence/postgres/request-repository.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresTenantCatalogueRepository } from '../src/persistence/postgres/tenant-catalogue-repository.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createHttpServer } from '../src/server.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { cateringId as id, cateringOrderFixture } from '../tests/support/catering-order-fixture.js';

const ORIGIN = 'http://localhost:3000';
const ROOT = '/api/v1/tenant/catering/orders';

test('Catering orders retain scoped historical source, atomic quotes/decisions and actual session-CSRF HTTP boundaries', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database, databasePoolMax: 6 });
  t.after(() => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
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
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
  assert.equal(await rollbackLatest(pool), true); // Empty delivery schema049.
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const authorizationPolicy = createAuthorizationPolicy();
  const registry = createCateringConfigurationRegistry();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: 'synthetic-catering-orders-audit-key-32-bytes' });
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });
  const sessionService = createSessionService({ repository: createPostgresSessionRepository(pool, { auditRepository }),
    auditService, publicOrigin: ORIGIN, csrfSecret: 'synthetic-catering-orders-http-csrf-key-32-bytes' });
  const repository = createPostgresCateringOrderRepository(pool, { registry, auditRepository });
  const make = (selected = repository) => createCateringOrderService({ repository: selected, registry, authorizationPolicy, auditService });
  const service = make();
  const catalogueService = createTenantCatalogueService({ authorizationPolicy, auditService,
    repository: createPostgresTenantCatalogueRepository(pool, { auditRepository }) });
  const assignmentService = createCateringCatalogueAssignmentService({ authorizationPolicy, auditService,
    repository: createPostgresCateringCatalogueAssignmentRepository(pool, { registry, auditRepository }) });
  const configurationRepository = createPostgresCateringConfigurationRepository(pool, { registry, auditRepository });
  async function seedTenant(tenantId) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Synthetic Catering Tenant','active')", [tenantId]);
    for (const [user, name] of [[2, 'Synthetic Requester'], [20, 'Synthetic Manager'], [30, 'Synthetic Admin']]) {
      await pool.query('INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,$3)', [tenantId, id(user), name]);
    }
    await pool.query("INSERT INTO sites(tenant_id,id,name,time_zone) VALUES ($1,'site-a','Synthetic Site','Europe/Berlin')", [tenantId]);
    await pool.query("INSERT INTO rooms(tenant_id,id,site_id,name,capacity) VALUES ($1,'room-a','site-a','Synthetic Room',500)",
      [tenantId]);
  }
  await seedTenant(id(1)); await seedTenant(id(50));
  async function issue(tenantId, user, role, permissions, securityVersion = 1) {
    const value = await sessionService.issue({ tenantId, userId: id(user), roles: [role], permissions, securityVersion,
      providerIdentity: { provider: 'test_identity', reference: `synthetic-${user}` } }, { correlationId: id(90) });
    return { ...value, cookie: value.setCookie.split(';', 1)[0] };
  }
  const manager = await issue(id(1), 20, 'conference_manager', ['request:manage','tenant:catalogue:manage']);
  const admin = await issue(id(1), 30, 'tenant_admin', ['tenant:integrations:manage']);
  const foreign = await issue(id(50), 20, 'conference_manager', ['request:manage','tenant:catalogue:manage']);
  const employee = await issue(id(1), 2, 'employee', ['request:read']);
  const context = (actor = manager) => ({ principal: actor.principal,
    tenantContext: { tenantId: actor.principal.tenantId, status: 'active' }, correlationId: id(90) });
  function configuration(integrationId, expectedRevision = 0, enabled = true) {
    return { tenantId: id(1), integrationId, providerId: 'manual_catering', actorUserId: id(30),
      sessionId: admin.principal.session.id, expectedSecurityVersion: 1, expectedRevision, changedAt: new Date(), correlationId: id(90),
      configuration: { initialOrderMode: integrationId === id(3) ? 'manager_review' : 'after_conference_approval',
        capabilities: enabled ? { 'catering.order': 'manual' } : {} },
      auditEventFor({ revision }) { return auditService.createEvent({ ...context(admin), action: 'tenant.configuration.changed',
        targetType: 'integration', targetId: integrationId, previousState: { revision: expectedRevision }, newState: { revision },
        outcome: 'success', retentionClass: 'administrative', metadata: {
          operation: expectedRevision === 0 ? 'catering_configuration_initialize' : 'catering_configuration_update',
        } }); } };
  }
  for (const integrationId of [id(3), id(4)]) {
    await pool.query(`INSERT INTO integrations(tenant_id,id,provider,provider_reference,status)
      VALUES ($1,$2,'manual_catering',$3,'configured')`, [id(1), integrationId, `synthetic-order:${integrationId}`]);
    assert.equal((await configurationRepository.initialize(configuration(integrationId))).status, 'updated');
  }
  let sequence = 0;
  const build = (extra = {}) => cateringOrderFixture({ requestVersion: 1, catalogueRevision: 2,
    capturedAt: new Date(Date.now() - 3600000).toISOString(),
    startsAt: new Date(Date.now() + 172800000 + sequence++ * 7200000).toISOString(), ...extra });
  const initial = build();
  await catalogueService.update({ ...context(), schemaVersion: 1, expectedRevision: 1, catalogue: initial.canonicalCatalogue });
  await assignmentService.replace({ ...context(), schemaVersion: 1, expectedRevision: 0, catalogueRevision: 2,
    assignments: initial.ownership.assignments });
  async function seedRequest(fixture, requestId) {
    const value = { ...fixture.request, id: requestId };
    const event = auditService.createEvent({ principal: { tenantId: value.tenantId, userId: value.requesterUserId },
      tenantContext: { tenantId: value.tenantId, status: 'active' }, correlationId: id(90), action: 'request.created',
      targetType: 'request', targetId: requestId, newState: { status: value.status, version: value.version },
      outcome: 'success', retentionClass: 'business' });
    await withPostgresTransaction(pool, async (client) => {
      await client.query(`INSERT INTO requests(tenant_id,id,requester_user_id,room_id,status,starts_at,ends_at,
        internal_participants,external_participants,schema_version,request_version,request_snapshot,status_changed_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [value.tenantId, value.id, value.requesterUserId, value.roomId, value.status, value.startsAt, value.endsAt,
        value.internalParticipants, value.externalParticipants, value.schemaVersion, value.version, JSON.stringify(value.snapshot),
        value.statusChangedAt, value.createdAt, value.updatedAt]);
      await appendRequestRevisionWithClient(client, value, 'created', event, 'employee');
      await auditRepository.appendWithClient(client, event);
    });
    return value;
  }
  await seedRequest(initial, 'request-core');
  const prepare = (requestId, commandId, expectedAssignmentRevision = 1, actor = manager) => ({ ...context(actor), schemaVersion: 1,
    requestId, commandId, expectedRequestVersion: 1, expectedAssignmentRevision });
  const prepared = await Promise.all([service.prepare(prepare('request-core', id(60))), service.prepare(prepare('request-core', id(60)))]);
  assert.equal(prepared.filter((value) => value.replayed).length, 1);
  assert.deepEqual(prepared[0].orders.map((value) => value.orderId), prepared[1].orders.map((value) => value.orderId));
  assert.equal(prepared[0].orders.length, 2);
  const orderId = prepared[0].orders.find((value) => value.integrationId === id(3)).orderId;
  const otherOrderId = prepared[0].orders.find((value) => value.integrationId === id(4)).orderId;
  const count = async (table, where = '', values = []) => Number((await pool.query(`SELECT count(*) AS count FROM ${table} ${where}`,
    values)).rows[0].count);
  assert.equal(await count('catering_orders'), 2);
  assert.equal(await count('catering_order_version_seals'), 2);
  const restarted = createPostgresCateringOrderRepository(pool, { registry, auditRepository });
  const original = await make(restarted).load({ ...context(), orderId });
  assert.equal(original.order.positions[0].packageDetails.includedItems.length, 2);
  assert.equal(original.order.conferencePrice.amountMinor, 900);
  assert.equal(original.order.providerCost, null);
  assert.equal(original.state.status, 'pending_quote');
  await assert.rejects(service.prepare(prepare('request-core', id(61))), /ALREADY_PREPARED/);
  await assert.rejects(service.load({ ...context(foreign), orderId }), /RESOURCE_NOT_AVAILABLE/);
  await assert.rejects(service.load({ ...context(admin), orderId }));
  await assert.rejects(service.prepare({ ...prepare('request-core', id(60)), principal: {
    ...manager.principal, userId: admin.principal.userId, session: admin.principal.session,
  } }), /PRINCIPAL_NOT_AUTHORIZED/);
  const failedRepository = createPostgresCateringOrderRepository(pool, { registry, auditRepository: {
    async appendWithClient() { throw new Error('SYNTHETIC_ORDER_AUDIT_FAILURE'); },
  } });
  const failedService = make(failedRepository);
  await seedRequest(build(), 'request-audit-failure');
  await assert.rejects(failedService.prepare(prepare('request-audit-failure', id(62))), /SYNTHETIC_ORDER_AUDIT_FAILURE/);
  assert.equal(await count('catering_orders', 'WHERE request_id=$1', ['request-audit-failure']), 0);
  assert.equal(await count('catering_order_versions'), 2);
  const quote = (stateRevision, quoteRevision, amountMinor = 1200, actor = manager, target = orderId) => ({
    ...context(actor), schemaVersion: 1, orderId: target, expectedStateRevision: stateRevision, expectedQuoteRevision: quoteRevision,
    cost: { amountMinor, currency: 'EUR' }, expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const decision = (stateRevision, quoteRevision, actor = manager, selected = 'approved') => ({
    ...context(actor), schemaVersion: 1, orderId, expectedStateRevision: stateRevision,
      expectedQuoteRevision: quoteRevision, decision: selected,
  });
  await assert.rejects(failedService.recordQuote(quote(1, 0)), /SYNTHETIC_ORDER_AUDIT_FAILURE/);
  assert.equal(await count('catering_order_quotes'), 0);
  await assert.rejects(service.recordQuote({ ...quote(1, 0), expiresAt: new Date(Date.now() - 1000).toISOString() }), /QUOTE_EXPIRED/);
  const quotes = await Promise.allSettled([service.recordQuote(quote(1, 0)), service.recordQuote(quote(1, 0))]);
  assert.equal(quotes.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(quotes.filter((value) => value.status === 'rejected').length, 1);
  assert.equal(await count('catering_order_quotes'), 1);
  assert.equal((await service.load({ ...context(), orderId })).state.revision, 2);
  await assert.rejects(failedService.decide(decision(2, 1)), /SYNTHETIC_ORDER_AUDIT_FAILURE/);
  assert.equal(await count('catering_order_decisions'), 0);
  const accepted = await service.decide(decision(2, 1));
  assert.equal(accepted.state.status, 'released');
  assert.equal(accepted.decision.cost.amountMinor, 1200);
  assert.equal((await service.load({ ...context(), orderId: otherOrderId })).state.status, 'pending_quote');
  const changedQuote = await service.recordQuote(quote(3, 1, 1300));
  assert.equal(changedQuote.state.status, 'pending_manager_review');
  assert.equal(changedQuote.decision, null);
  assert.equal(await count('catering_order_decisions'), 1);
  await assert.rejects(service.decide(decision(4, 1)), /QUOTE_UNAVAILABLE/);
  const renewed = await service.decide(decision(4, 2));
  assert.equal(renewed.state.status, 'released'); assert.equal(renewed.decision.cost.amountMinor, 1300);
  assert.equal(await count('catering_order_decisions'), 2);
  assert.equal((await configurationRepository.update(configuration(id(4), 1, false))).status, 'updated');
  await assert.rejects(service.recordQuote(quote(1, 0, 50, manager, otherOrderId)), /CONNECTION_UNAVAILABLE/);
  assert.equal((await configurationRepository.update(configuration(id(4), 2, true))).status, 'updated');
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [manager.principal.session.id]);
  await assert.rejects(service.recordQuote(quote(5, 2)), /PRINCIPAL_NOT_AUTHORIZED/);
  await pool.query('UPDATE sessions SET revoked_at=NULL WHERE id=$1', [manager.principal.session.id]);
  await pool.query(`INSERT INTO sessions(id,tenant_id,user_id,token_hash,provider,provider_identity_reference,
    roles,permissions,principal_version,issued_at,expires_at) VALUES ($1,$2,$3,$4,'test_identity','synthetic-expired',
      ARRAY['conference_manager'],ARRAY['request:manage'],1,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day')`,
  [id(80), id(1), id(20), 'e'.repeat(64)]);
  await assert.rejects(service.recordQuote({ ...quote(5, 2), principal: { ...manager.principal,
    session: { ...manager.principal.session, id: id(80) } } }), /PRINCIPAL_NOT_AUTHORIZED/);
  await pool.query('UPDATE users SET security_version=2 WHERE tenant_id=$1 AND id=$2', [id(1), id(20)]);
  await assert.rejects(service.recordQuote(quote(5, 2)), /PRINCIPAL_NOT_AUTHORIZED/);
  const currentManager = await issue(id(1), 20, 'conference_manager', ['request:manage','tenant:catalogue:manage'], 2);
  const updated = build({ catalogueRevision: 3, unitPrice: 200 });
  await catalogueService.update({ ...context(currentManager), schemaVersion: 1,
    expectedRevision: 2, catalogue: updated.canonicalCatalogue });
  await assignmentService.replace({ ...context(currentManager), schemaVersion: 1, expectedRevision: 1,
    catalogueRevision: 3, assignments: updated.ownership.assignments });
  const historical = await service.load({ ...context(currentManager), orderId });
  assert.equal(historical.order.catalogueRevision, 2);
  assert.equal(historical.order.positions[0].packageDetails.includedItems[0].price.amountMinor, 100);
  const replay = await service.prepare(prepare('request-core', id(60), 1, currentManager));
  assert.equal(replay.replayed, true);
  assert.equal(await count('catering_orders'), 2);
  await seedRequest(updated, 'request-http');
  const tenantRepository = createPostgresTenantRepository(pool, { auditRepository });
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN,
    CATERING_CONFIGURATION_ENABLED: 'true', CATERING_ORDERS_ENABLED: 'true' });
  const server = createHttpServer({ config, authorizationPolicy, auditService, sessionService,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    additionalRouteModules: [...createCateringConfigurationRouteModules({ config, persistence: { pool, auditRepository },
      authorizationPolicy, auditService }), ...createCateringOrderRouteModules({ config, persistence: { pool, auditRepository },
      authorizationPolicy, auditService })],
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const exchange = ({ actor, path = ROOT, method = 'GET', csrf, body, requestOrigin = ORIGIN } = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        Host: new URL(ORIGIN).host, Origin: requestOrigin, ...(actor ? { Cookie: actor.cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
      outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    assert.equal((await exchange()).status, 401);
    assert.equal((await exchange({ actor: admin })).status, 403);
    assert.equal((await exchange({ actor: employee })).status, 403);
    assert.deepEqual((await exchange({ actor: foreign })).body.orders, []);
    assert.equal((await exchange({ actor: foreign, path: `${ROOT}/${orderId}` })).status, 404);
    assert.equal((await exchange({ actor: currentManager, path: '/api/v1/integrations/catering' })).status, 403);
    const command = { schemaVersion: 1, requestId: 'request-http', commandId: id(70), expectedRequestVersion: 1,
      expectedAssignmentRevision: 2 };
    for (const options of [{}, { csrf: manager.csrfToken }, { csrf: foreign.csrfToken }, { csrf: 'x'.repeat(43) },
      { csrf: currentManager.csrfToken, requestOrigin: 'https://foreign.invalid' }]) {
      assert.equal((await exchange({ actor: currentManager, method: 'POST', body: command, ...options })).status, 403);
      assert.equal((await exchange({ actor: currentManager, path: `${ROOT}/${orderId}/quote`, method: 'PUT',
        body: {}, ...options })).status, 403);
      assert.equal((await exchange({ actor: currentManager, path: `${ROOT}/${orderId}/decision`, method: 'POST',
        body: {}, ...options })).status, 403);
    }
    assert.equal((await exchange({ actor: currentManager, method: 'POST', csrf: currentManager.csrfToken,
      body: { ...command, tenantId: id(50) } })).status, 400);
    const created = await exchange({ actor: currentManager, method: 'POST', csrf: currentManager.csrfToken, body: command });
    assert.equal(created.status, 200); assert.equal(created.body.orders.length, 2);
    const target = created.body.orders[0].orderId;
    const quoted = await exchange({ actor: currentManager, path: `${ROOT}/${target}/quote`, method: 'PUT', csrf: currentManager.csrfToken,
      body: { schemaVersion: 1, expectedStateRevision: 1, expectedQuoteRevision: 0,
        cost: { amountMinor: 500, currency: 'EUR' }, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
    assert.equal(quoted.status, 200); assert.equal(quoted.body.state.status, 'pending_manager_review');
    const approve = { schemaVersion: 1, expectedStateRevision: 2, expectedQuoteRevision: 1, decision: 'approved' };
    assert.equal((await exchange({ actor: admin, path: `${ROOT}/${target}/decision`, method: 'POST', csrf: admin.csrfToken,
      body: approve })).status, 403);
    const decided = await exchange({ actor: currentManager, path: `${ROOT}/${target}/decision`, method: 'POST',
      csrf: currentManager.csrfToken, body: approve });
    assert.equal(decided.status, 200); assert.equal(decided.body.state.status, 'released');
    assert.equal((await exchange({ actor: currentManager, path: `${ROOT}/${target}/decision`, method: 'POST',
      csrf: currentManager.csrfToken, body: approve })).status, 409);
    await sessionService.revoke(currentManager.principal, { correlationId: id(90) });
    assert.equal((await exchange({ actor: currentManager })).status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  const finalManager = await issue(id(1), 20, 'conference_manager', ['request:manage','tenant:catalogue:manage'], 2);
  for (let index = 0; index < 9; index++) {
    const next = build({ catalogueRevision: 3, unitPrice: 200 });
    await seedRequest(next, `request-page-${index}`);
    await service.prepare(prepare(`request-page-${index}`, id(1000 + index), 2, finalManager));
  }
  const firstPage = await service.list(context(finalManager));
  assert.equal(firstPage.orders.length, 20); assert.equal(firstPage.nextAfterOrderId, firstPage.orders.at(-1).orderId);
  const secondPage = await service.list({ ...context(finalManager), afterOrderId: firstPage.nextAfterOrderId });
  assert.equal(secondPage.orders.length, 2); assert.equal(secondPage.nextAfterOrderId, null);
  assert.equal(new Set([...firstPage.orders,...secondPage.orders].map((entry) => entry.orderId)).size, 22);
  assert.deepEqual((await service.list(context(foreign))).orders, []);
  const full = build({ catalogueRevision: 4, includedCount: 200, extraCount: 100, includedSelection: false,
    quantity: 1000, participants: 500, unitPrice: 1000000000, packagePrice: 1000000000 });
  for (const entry of full.ownership.assignments) entry.integrationId = id(3);
  await catalogueService.update({ ...context(finalManager), schemaVersion: 1, expectedRevision: 3, catalogue: full.canonicalCatalogue });
  await assignmentService.replace({ ...context(finalManager), schemaVersion: 1, expectedRevision: 2,
    catalogueRevision: 4, assignments: full.ownership.assignments });
  await seedRequest(full, 'request-full');
  const fullOrder = await service.prepare(prepare('request-full', id(71), 3, finalManager));
  assert.equal(fullOrder.orders.length, 1);
  const fullView = await service.load({ ...context(finalManager), orderId: fullOrder.orders[0].orderId });
  assert.equal(fullView.order.positions.length, 101);
  assert.equal(fullView.order.conferencePrice.amountMinor, 100500000000000);
  assert.equal(fullView.order.positions[0].packageDetails.includedItems.length, 200);
  const components = build({ catalogueRevision: 5, includedCount: 300, extraCount: 0,
    includedIds: [...Array.from({ length: 200 }, (_, n) => `included-${n}`),
      ...Array.from({ length: 100 }, (_, n) => `extra-${n}`)] });
  await catalogueService.update({ ...context(finalManager), schemaVersion: 1,
    expectedRevision: 4, catalogue: components.canonicalCatalogue });
  await assignmentService.replace({ ...context(finalManager), schemaVersion: 1, expectedRevision: 3,
    catalogueRevision: 5, assignments: components.ownership.assignments });
  await seedRequest(components, 'request-components');
  const componentOrder = await service.prepare(prepare('request-components', id(72), 4, finalManager));
  assert.equal((await service.load({ ...context(finalManager), orderId: componentOrder.orders[0].orderId }))
    .order.positions[0].packageDetails.includedItems.length, 300);
  await assert.rejects(pool.query(`INSERT INTO catering_order_positions(tenant_id,order_id,version,position_id,kind,entry_id)
    VALUES ($1,$2,1,$3,'item','late-entry')`, [id(1), orderId, id(800)]), /VERSION_SEALED/);
  await assert.rejects(pool.query('DELETE FROM catering_order_quotes WHERE tenant_id=$1', [id(1)]), /APPEND_ONLY/);
  await assert.rejects(pool.query('UPDATE catering_order_heads SET current_version=current_version+2 WHERE tenant_id=$1', [id(1)]),
    (error) => error.code === '23514');
  await assert.rejects(pool.query(`UPDATE catering_order_version_states SET revision=revision+1,status='released'
    WHERE tenant_id=$1 AND order_id=$2 AND version=1`, [id(1), componentOrder.orders[0].orderId]), (error) => error.code === '23514');
  assert.equal(await auditRepository.verifyTenantChain(id(1)), true);
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
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
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
  assert.equal(await rollbackLatest(pool), true); // Empty delivery schema049.
  await assert.rejects(rollbackLatest(pool), /CATERING_ORDER_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
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
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
  assert.equal(await rollbackLatest(pool), true); // Remove delivery FKs before explicit order fixture cleanup.
  await pool.query(`TRUNCATE catering_order_version_states,catering_order_decisions,catering_order_quotes,catering_order_heads,
    catering_order_version_seals,catering_order_positions,catering_order_versions,catering_orders`);
  await assert.rejects(rollbackLatest(pool), /CATERING_ORDER_AUDIT_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await auditRepository.verifyTenantChain(id(1)), true);
});
