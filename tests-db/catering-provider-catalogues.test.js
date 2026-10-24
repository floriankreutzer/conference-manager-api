import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringProviderCatalogueService } from '../src/application/catering-provider-catalogue-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringConfigurationRouteModules } from '../src/catering-configuration-composition.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createPostgresCateringProviderCatalogueRepository } from '../src/persistence/postgres/catering-provider-catalogue-repository.js';
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
const source = () => ({ schemaVersion: 1, sourceVersion: 'synthetic-supplier-1',
  items: Array.from({ length: 6 }, (_, i) => ({ id: `item-${i}`, name: `Synthetic supplier item ${i}`,
    description: 'ä'.repeat(1000), providerPrice: { amountMinor: i * 100, currency: 'EUR' } })), packages: [],
  terms: { minimumLeadTimeMinutes: 120, minimumOrderValue: null, changeCutoffMinutes: null, cancelCutoffMinutes: 60 } });

test('actual Customer source fences authority, preserves reviewed state, enforces completion and resets with restricted roles',
  async (t) => {
    const database = loadDatabaseConfig(process.env, 'test');
    if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
    const admin = createPostgresPool({ mode: 'test', ...database });
    const name = `conference_manager_demo_catalogue_source_${process.pid}`;
    const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key, `cm_source_${key}_${process.pid}`]));
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
    assert.equal(await isPostgresSchemaReady(pool),true);
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty029 before unchanged028/older guards.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty028 before unchanged027.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty027 before unchanged026.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty overlay026 before025.
    await rollbackLatestDemoMigration(pool,{ roles }); // Protected runtime025 before retained Microsoft024.
    await rollbackLatestDemoMigration(pool,{ roles }); // Microsoft flow024 before retained Customer023.
    await rollbackLatestDemoMigration(pool,{ roles }); // Customer023 before retained enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Enrollment grants022 before retained publication021.
    await rollbackLatestDemoMigration(pool,{ roles }); // Publication grants021 while canonical055 is ready.
    await rollbackLatestDemoMigration(pool,{ roles }); // Original source grants020 before either schema rollback.
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
    assert.equal(await rollbackLatest(pool),true); // Empty055.
    assert.equal(await rollbackLatest(pool),true); // Original054.
    await migrateUp(pool); await migrateDemoUp(pool,{ roles });
    function rolePool(role) {
      const scoped = { async connect() {
        const client = await pool.connect();
        return { async query(query, values) {
          const answer = await client.query(query,values);
          if (typeof query === 'string' && query.startsWith('BEGIN ')) await client.query(`SET LOCAL ROLE "${role}"`);
          return answer;
        }, release(error) { client.release(error); } };
      }, query(query, values) { return withPostgresTransaction(scoped,(client) => client.query(query,values)); } };
      return scoped;
    }
    const customer = rolePool(roles.customer); const platform = rolePool(roles.platform);
    const fixture = await createCateringDeliveryFixture(pool,{ manualCatalogue: true });
    // Deliberately no request:manage: source custody is Catalogue Manager authority.
    const manager = await fixture.sessionService.issue({ tenantId: fixture.tenantId, userId: id(20), roles: ['conference_manager'],
      permissions: ['tenant:catalogue:manage'], securityVersion: 1,
      providerIdentity: { provider: 'test_identity', reference: 'synthetic-catalogue-manager' } }, { correlationId: id(90) });
    const context = { ...fixture.context(manager), integrationId: fixture.integrationId };
    const application = { authorizationPolicy: createAuthorizationPolicy(), auditService: fixture.auditService };
    const dependencies = { registry: fixture.registry, auditRepository: fixture.auditRepository };
    const make = (auditRepository = fixture.auditRepository,maxResponseBytes = 262144) => createCateringProviderCatalogueService({
      ...application, registry: fixture.registry, maxResponseBytes,
      repository: createPostgresCateringProviderCatalogueRepository(customer,{ ...dependencies,auditRepository }) });
    const catalogues = make(); let sequence = 5000;
    const command = (expectedRevision, expectedConfigurationRevision = 1) => ({ schemaVersion: 1, commandId: id(sequence++),
      expectedRevision,expectedConfigurationRevision,reference: 'Synthetic actually received supplier list',
      attestReceivedFromSupplier: true,source: source() });
    const receive = (intent,service = catalogues,authority = context) => service.receive({ ...authority,command: intent });
    const snapshot = async () => ({
      catalogue: (await pool.query('SELECT catalog_revision FROM tenants WHERE id=$1',[fixture.tenantId])).rows,
      history: (await pool.query('SELECT revision,snapshot FROM tenant_catalogue_revisions WHERE tenant_id=$1 ORDER BY revision',
        [fixture.tenantId])).rows,
      assignment: (await pool.query('SELECT revision FROM catering_catalogue_assignment_heads WHERE tenant_id=$1',[fixture.tenantId])).rows,
    });
    const prepared = await fixture.createPreparedOrder(); const orderBefore = JSON.stringify(prepared.order);
    const before = await snapshot();
    const privileges = (await pool.query(`SELECT
      has_table_privilege($1,'catering_provider_catalogue_revisions','INSERT') AS append,
      has_table_privilege($1,'catering_provider_catalogue_revisions','UPDATE') AS mutate,
      has_table_privilege($1,'catering_provider_catalogue_revisions','DELETE') AS remove,
      has_table_privilege($1,'catering_provider_catalogue_heads','UPDATE') AS advance,
      has_table_privilege($2,'catering_provider_catalogue_revisions','SELECT') AS platform,
      has_table_privilege($3,'catering_provider_catalogue_revisions','TRUNCATE') AS reset,
      has_function_privilege($1,'catering_provider_catalogue_document_valid(jsonb)','EXECUTE') AS validator`,
    [roles.customer,roles.platform,roles.reset])).rows[0];
    assert.deepEqual(privileges,{ append: true,mutate: false,remove: false,advance: true,platform: false,reset: true,validator: false });
    await assert.rejects(platform.query('SELECT source FROM catering_provider_catalogue_revisions'),(error) => error.code === '42501');
    const first = command(0); const concurrent = await Promise.all([receive(first),receive(first)]);
    assert.deepEqual(concurrent.map((value) => value.replayed).sort(),[false,true]);
    const firstTime = concurrent[0].recordedAt; assert.equal(concurrent[1].recordedAt,firstTime);
    assert.deepEqual(await snapshot(),before);
    assert.equal(JSON.stringify((await fixture.orders.load({ ...fixture.context(),orderId: prepared.order.orderId })).order),orderBefore);
    await assert.rejects(receive({ ...first,reference: 'Changed body' }),(error) => error.code.endsWith('COMMAND_CONFLICT'));
    await assert.rejects(receive(command(0)),(error) => error.code.endsWith('REVISION_CONFLICT'));
    await assert.rejects(receive(command(1,2)),(error) => error.code.endsWith('CONFIGURATION_CONFLICT'));
    await assert.rejects(receive(command(1),catalogues,{ ...fixture.context(fixture.admin),integrationId: fixture.integrationId }),
      (error) => error.name === 'AuthorizationDeniedError');
    const failAudit = { async appendWithClient() { throw new Error('SYNTHETIC_SOURCE_AUDIT_FAILURE'); } };
    await assert.rejects(receive(command(1),make(failAudit)),/SYNTHETIC_SOURCE_AUDIT_FAILURE/);
    assert.equal((await catalogues.load(context)).currentRevision,1);
    // Real SQL constraints and deferred completion, including owner bypass of role grants.
    const insert = `INSERT INTO catering_provider_catalogue_revisions
      (tenant_id,integration_id,revision,configuration_revision,command_id,provider_id,reference,attest_received_from_supplier,
        source,recorded_by_user_id,actor_security_version,correlation_id,recorded_at)
      VALUES ($1,$2,2,1,$3,'manual_catering',$4,true,$5::jsonb,$6,$7,$8,'2000-01-01T00:00:00Z')`;
    const raw = (document = source(),reference = 'Synthetic raw source',epoch = 1) => [fixture.tenantId,fixture.integrationId,
      id(sequence++),reference,JSON.stringify(document),id(20),epoch,id(90)];
    for (const values of [raw({ ...source(),published: true }),raw(source(),'<unsafe>'),
      raw(source(),'Synthetic old epoch',2),raw(source(),'\u00a0Untrimmed reference'),
      raw({ ...source(),sourceVersion: 'e\u0301' })]) {
      await assert.rejects(customer.query(insert,values),(error) => error.code === '23514');
    }
    await assert.rejects(withPostgresTransaction(customer,async (client) => {
      const inserted = await client.query(`${insert} RETURNING recorded_at`,raw());
      assert.notEqual(inserted.rows[0].recorded_at.toISOString(),'2000-01-01T00:00:00.000Z');
      await client.query('UPDATE catering_provider_catalogue_heads SET revision=2 WHERE tenant_id=$1 AND integration_id=$2',
        [fixture.tenantId,fixture.integrationId]); // Deliberately omit the exact audit completion.
    }),(error) => error.code === '23514' && error.message.includes('COMPLETION_REQUIRED'));
    assert.equal((await catalogues.load(context)).currentRevision,1);
    await assert.rejects(customer.query(insert.replace("'manual_catering'","'foreign_provider'"),raw()),
      (error) => error.code === '23514');
    await assert.rejects(customer.query('UPDATE catering_provider_catalogue_heads SET revision=3'),
      (error) => error.code === '23514');
    await assert.rejects(customer.query('UPDATE catering_provider_catalogue_revisions SET reference=$1',['forged']),
      (error) => error.code === '42501');
    await assert.rejects(pool.query('UPDATE catering_provider_catalogue_revisions SET reference=$1',['forged']),
      (error) => error.code === '55000' && error.message === 'CATERING_ORDER_HISTORY_APPEND_ONLY');
    const competitors = await Promise.allSettled([receive(command(1)),receive(command(1))]);
    assert.equal(competitors.filter((entry) => entry.status === 'fulfilled' && entry.value.revision === 2).length,1);
    assert.equal(competitors.filter((entry) => entry.status === 'rejected'
      && entry.reason.code.endsWith('REVISION_CONFLICT')).length,1);
    for (let revision = 2; revision < 21; revision++) await receive(command(revision));
    const history = await catalogues.load(context); assert.equal(history.revisions.length,20);
    assert.equal(history.currentRevision,21); assert.equal(history.nextBeforeRevision,2);
    assert.deepEqual((await catalogues.load({ ...context,beforeRevision: 2 })).revisions.map((entry) => entry.revision),[1]);
    assert.equal((await catalogues.load({ ...context,beforeRevision: 1 })).nextBeforeRevision,null);
    assert.doesNotMatch(JSON.stringify(history),/providerPrice|Synthetic supplier item|actorUserId|commandId|source.*items/);
    const small = make(fixture.auditRepository,4096); const entries = []; let afterEntryId = null;
    do {
      const page = await small.loadRevision({ ...context,revision: 1,section: 'items',afterEntryId });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096); assert.ok(page.entries.length > 0);
      assert.equal(page.entries[0].providerPrice.currency,'EUR');
      entries.push(...page.entries.map((entry) => entry.id)); afterEntryId = page.nextAfterEntryId;
    } while (afterEntryId !== null);
    assert.deepEqual(entries,source().items.map((entry) => entry.id));
    await fixture.setOrderCapability(false);
    const lookup = await catalogues.listConnections(context);
    assert.deepEqual(lookup.connections.map((entry) => entry.integrationId),[fixture.integrationId]);
    assert.equal(lookup.connections[0].canReceive,false);
    const disabled = await catalogues.load(context); assert.equal(disabled.canReceive,false);
    assert.equal(disabled.configurationRevision,2);
    assert.equal((await receive(first)).replayed,true); // Authorized historical replay precedes current configuration CAS.
    await assert.rejects(receive(command(21,2)),(error) => error.code.endsWith('SOURCE_UNAVAILABLE'));
    await fixture.setOrderCapability(true);
    assert.equal((await catalogues.load(context)).canReceive,true);
    assert.equal((await catalogues.loadRevision({ ...context,revision: 1 })).configurationRevision,1);
    assert.deepEqual(await snapshot(),before);
    assert.equal(await fixture.auditRepository.verifyTenantChain(fixture.tenantId),true);
    const receivedAudit = await pool.query(`SELECT previous_state,new_state,metadata FROM audit_events
      WHERE action='catering.catalogue.received'`);
    assert.equal(receivedAudit.rowCount,21);
    assert.doesNotMatch(JSON.stringify(receivedAudit.rows),/providerPrice|reference|Synthetic supplier/);
    const config = loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: ORIGIN,CATERING_CONFIGURATION_ENABLED: 'true' });
    const modules = createCateringConfigurationRouteModules({ config,...application,
      persistence: { pool: customer,auditRepository: fixture.auditRepository } });
    const tenants = createPostgresTenantRepository(pool);
    const server = createHttpServer({ config,...application,additionalRouteModules: modules,sessionService: fixture.sessionService,
      loadTenant: (tenantId) => tenants.findById(tenantId),
      logger: { requestCompleted() {},healthEvaluated() {},securityOutcome() {},unhandledError() {} } });
    await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
    t.after(() => new Promise((resolve,reject) => server.close((error) => error ? reject(error) : resolve())));
    const root = `/api/v1/tenant/catering/provider-catalogues/${fixture.integrationId}`;
    function request(actor,{ method = 'GET',suffix = '',csrf = null,body,origin = ORIGIN,collection = false } = {}) {
      return new Promise((resolve,reject) => {
        const outgoing = http.request({ hostname: '127.0.0.1',port: server.address().port,method,
          path: (collection ? '/api/v1/tenant/catering/provider-catalogues' : root)+suffix,
          headers: { Host: new URL(ORIGIN).host,Origin: origin,
            ...(actor ? { Cookie: actor.setCookie.split(';',1)[0] } : {}),...(csrf ? { 'X-CSRF-Token': csrf } : {}),
            ...(body ? { 'Content-Type': 'application/json','Content-Length': Buffer.byteLength(body) } : {}) } },(response) => {
          const chunks = []; response.on('data',(chunk) => chunks.push(chunk));
          response.on('end',() => resolve({ status: response.statusCode,body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        outgoing.setTimeout(5000,() => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
        outgoing.on('error',reject); outgoing.end(body);
      });
    }
    assert.equal((await request()).status,401); assert.equal((await request(fixture.admin)).status,403);
    assert.equal((await request(manager)).status,200);
    const discovered = await request(manager,{ collection: true }); assert.equal(discovered.status,200);
    assert.deepEqual(discovered.body.connections.map((entry) => entry.integrationId),[fixture.integrationId]);
    const employee = await fixture.sessionService.issue({ tenantId: fixture.tenantId,userId: id(2),roles: ['employee'],
      permissions: [],securityVersion: 1,providerIdentity: { provider: 'test_identity',reference: 'synthetic-source-employee' } },
    { correlationId: id(90) });
    assert.equal((await request(employee)).status,403);
    assert.equal((await request(employee,{ collection: true })).status,403);
    assert.equal((await request(employee,{ suffix: '/revisions/1' })).status,403);
    assert.equal((await request(manager,{ suffix: '/revisions/1?section=items' })).status,200);
    assert.equal((await request(manager,{ suffix: '?tenantId=foreign' })).status,400);
    assert.equal((await request(manager,{ body: '{}' })).status,400);
    const post = JSON.stringify(command(21,3));
    assert.equal((await request(manager,{ method: 'POST',body: post })).status,403);
    assert.equal((await request(manager,{ method: 'POST',body: post,csrf: manager.csrfToken,
      origin: 'https://foreign.invalid' })).status,403);
    const saved = await request(manager,{ method: 'POST',body: post,csrf: manager.csrfToken });
    assert.equal(saved.status,200); assert.equal(saved.body.revision,22);
    assert.equal((await request(manager,{ method: 'POST',body: post,csrf: manager.csrfToken })).body.replayed,true);
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Foreign Synthetic Catalogue Tenant','active')",[id(50)]);
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Foreign Synthetic Manager')",[id(50),id(20)]);
    const foreign = await fixture.sessionService.issue({ tenantId: id(50),userId: id(20),roles: ['conference_manager'],
      permissions: ['tenant:catalogue:manage'],securityVersion: 1,
      providerIdentity: { provider: 'test_identity',reference: 'synthetic-foreign-catalogue-manager' } },{ correlationId: id(90) });
    assert.equal((await request(foreign)).status,404);
    const hidden = await request(foreign,{ collection: true }); assert.equal(hidden.status,200);
    assert.deepEqual(hidden.body.connections,[]);
    assert.equal((await request(foreign,{ suffix: '/revisions/1' })).status,404);
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
      [fixture.tenantId,manager.principal.session.id]);
    assert.equal((await request(manager)).status,401);
    await assert.rejects(receive(command(22,3)),(error) => error.code === 'PRINCIPAL_NOT_AUTHORIZED');
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty029 before unchanged028/older guards.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty028 before unchanged027.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty027 before unchanged026.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty overlay026 before025.
    await rollbackLatestDemoMigration(pool,{ roles }); // Protected runtime025 before retained Microsoft024.
    await rollbackLatestDemoMigration(pool,{ roles }); // Microsoft flow024 before retained Customer023.
    await rollbackLatestDemoMigration(pool,{ roles }); // Customer023 before retained enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Retained publication021.
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
    assert.equal(await rollbackLatest(pool),true); // Empty enrollment056.
    assert.equal(await rollbackLatest(pool),true); // Retained publication055.
    await assert.rejects(rollbackLatest(pool),/CATERING_PROVIDER_CATALOGUE_ROLLBACK_REQUIRES_REVIEW/);
    await migrateUp(pool); await migrateDemoUp(pool,{ roles });
    const reset = createPostgresDemoResetRepository({ pool: rolePool(roles.reset),
      expectedDatabaseName: name,expectedResetRole: roles.reset });
    assert.equal((await reset.reset({ fixture: DEMO_FIXTURE,checksum: DEMO_FIXTURE_CHECKSUM })).checksum,DEMO_FIXTURE_CHECKSUM);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_provider_catalogue_revisions')).rows[0].count,0);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_provider_catalogue_heads')).rows[0].count,0);
    const persona = DEMO_FIXTURE.customerPersonas[0];
    await fixture.auditService.record({ principal: { tenantId: persona.tenantId,userId: persona.userId },
      tenantContext: { tenantId: persona.tenantId },correlationId: id(90),action: 'catering.catalogue.received',
      targetType: 'integration',targetId: fixture.integrationId,outcome: 'success',retentionClass: 'business',
      previousState: { revision: 0 },newState: { revision: 1 },metadata: { operation: 'synthetic_audit_only_rollback_probe' } });
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty029 before unchanged028/older guards.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty028 before unchanged027.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty027 before unchanged026.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty overlay026 before025.
    await rollbackLatestDemoMigration(pool,{ roles }); // Protected runtime025 before retained Microsoft024.
    await rollbackLatestDemoMigration(pool,{ roles }); // Microsoft flow024 before retained Customer023.
    await rollbackLatestDemoMigration(pool,{ roles }); // Customer023 before retained enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Retained publication021.
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
    assert.equal(await rollbackLatest(pool),true); // Empty enrollment056.
    assert.equal(await rollbackLatest(pool),true); // Retained publication055.
    await assert.rejects(rollbackLatest(pool),/CATERING_PROVIDER_CATALOGUE_ROLLBACK_REQUIRES_REVIEW/);
    await migrateUp(pool); await migrateDemoUp(pool,{ roles });
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_provider_catalogue_revisions')).rows[0].count,0);
    assert.equal((await reset.reset({ fixture: DEMO_FIXTURE,checksum: DEMO_FIXTURE_CHECKSUM })).checksum,DEMO_FIXTURE_CHECKSUM);
  });
