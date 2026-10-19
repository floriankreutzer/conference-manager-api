import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringCataloguePublicationService } from '../src/application/catering-catalogue-publication-service.js';
import { createCateringProviderCatalogueService } from '../src/application/catering-provider-catalogue-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresCateringCataloguePublicationRepository
} from '../src/persistence/postgres/catering-catalogue-publication-repository.js';
import { createPostgresCateringProviderCatalogueRepository } from '../src/persistence/postgres/catering-provider-catalogue-repository.js';
import { createPostgresTenantCatalogueRepository } from '../src/persistence/postgres/tenant-catalogue-repository.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { createPostgresPool,isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { DEMO_FIXTURE,DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { migrateDemoUp,rollbackLatestDemoMigration } from '../scripts/demo-db-migrations.mjs';
import { createCateringDeliveryFixture } from './support/catering-delivery-fixture.js';
import { cateringId as id } from '../tests/support/catering-order-fixture.js';

const money = (amountMinor) => ({ amountMinor,currency: 'EUR' });
const source = () => ({ schemaVersion: 1,sourceVersion: 'synthetic-reviewed-list',items: [{ id: 'source-coffee',
  name: 'Synthetic received coffee',description: null,providerPrice: money(250) }],packages: [{ id: 'source-break',
  name: 'Synthetic received break',description: null,providerPrice: null,itemIds: ['source-coffee'],variants: [{
    id: 'source-standard',name: 'Synthetic received standard',description: null,providerPrice: money(0) }] }],
terms: { minimumLeadTimeMinutes: null,minimumOrderValue: null,changeCutoffMinutes: null,cancelCutoffMinutes: null } });
const mapping = (sourceId,entryId,amountMinor = 700) => ({ sourceId,entryId,price: money(amountMinor),active: true,
  order: 0,siteIds: [],roomIds: [] });

test('actual Customer publication atomically fences reviewed content, ownership, replay, audit and reset without changing prior orders',
  async (t) => {
    const database = loadDatabaseConfig(process.env,'test');
    if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
    const admin = createPostgresPool({ mode: 'test',...database });
    const name = `conference_manager_demo_publication_${process.pid}`;
    const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key,`cm_publish_${key}_${process.pid}`]));
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
    pool = createPostgresPool({ mode: 'test',...database,databaseUrl: url.toString(),databasePoolMax: 6 });
    await migrateUp(pool); await migrateDemoUp(pool,{ roles });
    assert.equal(await isPostgresSchemaReady(pool),true);
    await rollbackLatestDemoMigration(pool,{ roles }); assert.equal(await rollbackLatest(pool),true);
    await migrateUp(pool); await migrateDemoUp(pool,{ roles });
    function rolePool(role) {
      const scoped = { async connect() {
        const client = await pool.connect();
        return { async query(query,values) {
          const answer = await client.query(query,values);
          if (typeof query === 'string' && query.startsWith('BEGIN ')) await client.query(`SET LOCAL ROLE "${role}"`);
          return answer;
        },release(error) { client.release(error); } };
      },query(query,values) { return withPostgresTransaction(scoped,(client) => client.query(query,values)); } };
      return scoped;
    }
    const customer = rolePool(roles.customer); const platform = rolePool(roles.platform);
    const fixture = await createCateringDeliveryFixture(pool,{ manualCatalogue: true });
    const manager = await fixture.sessionService.issue({ tenantId: fixture.tenantId,userId: id(20),roles: ['conference_manager'],
      permissions: ['tenant:catalogue:manage'],securityVersion: 1,
      providerIdentity: { provider: 'test_identity',reference: 'synthetic-publication-manager' } },{ correlationId: id(90) });
    const context = { ...fixture.context(manager),integrationId: fixture.integrationId };
    const dependencies = { registry: fixture.registry,auditRepository: fixture.auditRepository };
    const application = { authorizationPolicy: createAuthorizationPolicy(),auditService: fixture.auditService };
    const intake = createCateringProviderCatalogueService({ ...application,registry: fixture.registry,
      repository: createPostgresCateringProviderCatalogueRepository(customer,dependencies) });
    const make = (auditRepository = fixture.auditRepository,alterPlan = null) => {
      const repository = createPostgresCateringCataloguePublicationRepository(customer,{ ...dependencies,auditRepository });
      return createCateringCataloguePublicationService({ ...application,repository: alterPlan ? {
        review(input) { return repository.review({ ...input,planFor(state) { return alterPlan(input.planFor(state)); } }); },
      } : repository });
    };
    const publication = make(); let sequence = 7000;
    const receive = (expectedRevision) => intake.receive({ ...context,command: { schemaVersion: 1,commandId: id(sequence++),
      expectedRevision,expectedConfigurationRevision: 1,reference: 'Synthetic actual supplier evidence',
      attestReceivedFromSupplier: true,source: source() } });
    const intent = (overrides = {}) => ({ schemaVersion: 1,commandId: id(sequence++),expectedReviewRevision: 0,
      expectedSourceRevision: 1,expectedConfigurationRevision: 1,expectedCatalogueRevision: 2,expectedAssignmentRevision: 1,
      expectedPublicationRevision: 0,decision: 'published',justification: 'Synthetic explicit content and commercial review',
      items: [mapping('source-coffee','reviewed-coffee')],packages: [{ ...mapping('source-break','reviewed-break',1200),variants: [{
        sourceId: 'source-standard',entryId: 'reviewed-standard',price: money(1200),active: true,order: 0 }] }],...overrides });
    const review = (command,service = publication,authority = context) => service.review({ ...authority,command });
    const snapshot = async () => JSON.stringify(await Promise.all([
      pool.query('SELECT catalog_revision FROM tenants WHERE id=$1',[fixture.tenantId]),
      pool.query('SELECT revision,snapshot FROM tenant_catalogue_revisions WHERE tenant_id=$1 ORDER BY revision',[fixture.tenantId]),
      pool.query('SELECT * FROM catering_catalogue_assignment_heads WHERE tenant_id=$1',[fixture.tenantId]),
      pool.query('SELECT * FROM catering_catalogue_review_heads WHERE tenant_id=$1',[fixture.tenantId]),
      pool.query('SELECT * FROM catering_catalogue_publication_heads WHERE tenant_id=$1',[fixture.tenantId]),
      pool.query('SELECT command_id,review_revision FROM catering_catalogue_reviews WHERE tenant_id=$1 ORDER BY review_revision',
        [fixture.tenantId]),
      pool.query('SELECT action,previous_state,new_state,metadata FROM audit_events WHERE tenant_id=$1 ORDER BY id',[fixture.tenantId]),
    ]).then((results) => results.map((result) => result.rows)));
    const prepared = await fixture.createPreparedOrder(); const orderBefore = JSON.stringify(prepared.order);
    const privileges = (await pool.query(`SELECT
      has_table_privilege($1,'catering_catalogue_reviews','INSERT') AS append,
      has_table_privilege($1,'catering_catalogue_reviews','UPDATE') AS mutate,
      has_table_privilege($1,'catering_catalogue_reviews','DELETE') AS remove,
      has_table_privilege($1,'catering_catalogue_publication_heads','UPDATE') AS advance,
      has_table_privilege($2,'catering_catalogue_reviews','SELECT') AS platform,
      has_table_privilege($3,'catering_catalogue_reviews','TRUNCATE') AS reset,
      has_function_privilege($1,'catering_catalogue_review_command_valid(jsonb)','EXECUTE') AS validator`,
    [roles.customer,roles.platform,roles.reset])).rows[0];
    assert.deepEqual(privileges,{ append: true,mutate: false,remove: false,advance: true,platform: false,reset: true,validator: false });
    await assert.rejects(platform.query('SELECT command FROM catering_catalogue_reviews'),(error) => error.code === '42501');
    await receive(0); const first = intent();
    for (const principal of [{ ...context.principal,roles: ['employee'] },{ ...context.principal,roles: ['tenant_admin'] },
      { ...context.principal,tenantId: id(99) },{ ...context.principal,permissions: [] }]) {
      await assert.rejects(review(first,publication,{ ...context,principal }));
    }
    async function rawRejection(command,extra = {}) {
      return withPostgresTransaction(customer,async (client) => {
        await client.query(`INSERT INTO catering_catalogue_reviews (tenant_id,integration_id,command_id,review_revision,
          source_revision,configuration_revision,publication_revision,catalogue_revision,assignment_revision,
          reviewed_by_user_id,actor_security_version,correlation_id,command,bindings)
          VALUES ($1,$2,$3,1,1,1,0,2,1,$4,$5,$6,$7::jsonb,'[]'::jsonb)`,
        [extra.tenantId ?? fixture.tenantId,fixture.integrationId,command.commandId,id(20),
          extra.epoch ?? 1,id(90),JSON.stringify(command)]);
        await client.query('INSERT INTO catering_catalogue_review_heads(tenant_id,integration_id,review_revision) VALUES ($1,$2,1)',
          [fixture.tenantId,fixture.integrationId]);
      });
    }
    const raw = intent({ decision: 'rejected',items: [],packages: [] });
    await assert.rejects(rawRejection(raw),(error) => error.code === '23514'
      && /COMPLETION_REQUIRED/.test(error.message));
    for (const change of [{ approved: true },{ justification: 'unsafe\u0085control' },{ expectedSourceRevision: 0 },
      { expectedCatalogueRevision: 3 },{ expectedReviewRevision: 1 }]) {
      await assert.rejects(rawRejection({ ...raw,...change }),(error) => error.code === '23514');
    }
    await assert.rejects(rawRejection(raw,{ tenantId: id(99) }),(error) => error.code === '23514');
    await assert.rejects(rawRejection(raw,{ epoch: 2 }),(error) => error.code === '23514');
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES ($1,'Foreign Synthetic Publication Tenant','active')",[id(99)]);
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES ($1,$2,'Foreign Synthetic Manager')",[id(99),id(20)]);
    const foreign = await fixture.sessionService.issue({ tenantId: id(99),userId: id(20),roles: ['conference_manager'],
      permissions: ['tenant:catalogue:manage'],securityVersion: 1,
      providerIdentity: { provider: 'test_identity',reference: 'synthetic-foreign-publication-manager' } },{ correlationId: id(90) });
    await assert.rejects(review(first,publication,{ ...context,...fixture.context(foreign),
      tenantContext: { tenantId: id(99),status: 'active' } }),(error) => error.code === 'RESOURCE_NOT_AVAILABLE' && error.conceal === true);
    const before = await snapshot();
    await assert.rejects(review(first,make({ async appendWithClient(client,event) {
      if (event.action === 'catering.catalogue.published') throw new Error('PUBLICATION_AUDIT_UNAVAILABLE');
      return fixture.auditRepository.appendWithClient(client,event);
    } })),
      /PUBLICATION_AUDIT_UNAVAILABLE/);
    assert.equal(await snapshot(),before);
    // The DB independently rejects a valid-looking planner result with an unreviewed selling price.
    await assert.rejects(review(first,make(fixture.auditRepository,(plan) => {
      const altered = structuredClone(plan); altered.catalogue.cateringItems.find((x) => x.id === 'reviewed-coffee').price.amountMinor++;
      return altered;
    })),(error) => error.code === '23514');
    assert.equal(await snapshot(),before);
    const concurrent = await Promise.all([review(first),review(first)]);
    assert.deepEqual(concurrent.map((x) => x.replayed).sort(),[false,true]);
    assert.equal(concurrent[0].recordedAt,concurrent[1].recordedAt);
    assert.equal(concurrent[0].catalogueRevision,3); assert.equal(concurrent[0].assignmentRevision,2);
    assert.equal(concurrent[0].publicationRevision,1); assert.equal(concurrent[0].reviewRevision,1);
    await assert.rejects(review({ ...first,justification: 'Changed command intent' }),(error) => error.code.endsWith('COMMAND_CONFLICT'));
    const catalogue = createPostgresTenantCatalogueRepository(customer,{ auditRepository: fixture.auditRepository });
    const current = await catalogue.loadCurrent(fixture.tenantId);
    assert.equal(current.catalogue.cateringItems.find((x) => x.id === 'reviewed-coffee').price.amountMinor,700);
    assert.equal(current.catalogue.cateringItems.find((x) => x.id === 'reviewed-coffee').name,source().items[0].name);
    assert.equal(JSON.stringify((await fixture.orders.load({ ...fixture.context(),orderId: prepared.order.orderId })).order),orderBefore);
    await receive(1);
    const next = intent({ expectedReviewRevision: 1,expectedSourceRevision: 2,expectedCatalogueRevision: 3,
      expectedAssignmentRevision: 2,expectedPublicationRevision: 1 });
    await assert.rejects(review({ ...next,expectedSourceRevision: 1 }),(error) => error.code.endsWith('SOURCE_CONFLICT'));
    const rejected = { ...next,decision: 'rejected',items: [],packages: [] };
    const rejection = await review(rejected); assert.equal(rejection.reviewRevision,2);
    assert.equal(rejection.publicationRevision,1);
    assert.equal(rejection.catalogueRevision,3); assert.equal(rejection.assignmentRevision,2);
    assert.deepEqual(await catalogue.loadCurrent(fixture.tenantId),current);
    assert.equal((await review(first)).replayed,true);
    const remove = intent({ expectedReviewRevision: 2,expectedSourceRevision: 2,expectedCatalogueRevision: 3,
      expectedAssignmentRevision: 2,expectedPublicationRevision: 1,items: [],packages: [] });
    const distinct = await Promise.allSettled([review(remove),review({ ...remove,commandId: id(sequence++) })]);
    assert.equal(distinct.filter((x) => x.status === 'fulfilled').length,1);
    assert.equal(distinct.find((x) => x.status === 'rejected').reason.code,'CATERING_CATALOGUE_PUBLICATION_REVIEW_CONFLICT');
    const retired = (await catalogue.loadCurrent(fixture.tenantId)).catalogue;
    assert.equal(retired.cateringItems.find((x) => x.id === 'reviewed-coffee').active,false);
    assert.equal(retired.cateringPackages.find((x) => x.id === 'reviewed-break').variants[0].active,false);
    assert.equal(retired.cateringPackages.find((x) => x.id === 'package-a').active,true);
    for (const query of ['UPDATE catering_catalogue_reviews SET bindings=bindings','DELETE FROM catering_catalogue_reviews']) {
      await assert.rejects(customer.query(query),(error) => error.code === '42501');
      await assert.rejects(pool.query(query),(error) => error.code === '55000');
    }
    await assert.rejects(customer.query('DELETE FROM catering_catalogue_publication_heads'),(error) => error.code === '42501');
    await assert.rejects(pool.query('UPDATE catering_catalogue_review_heads SET review_revision=review_revision+2'),
      (error) => error.code === '23514');
    assert.equal(await fixture.auditRepository.verifyTenantChain(fixture.tenantId),true);
    const minimized = await pool.query(`SELECT previous_state,new_state,metadata FROM audit_events
      WHERE action IN ('catering.catalogue.published','catering.catalogue.rejected')`);
    assert.doesNotMatch(JSON.stringify(minimized.rows),/justification|source-coffee|providerPrice|1200|700/);
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
      [fixture.tenantId,manager.principal.session.id]);
    await assert.rejects(review(first),(error) => error.code === 'PRINCIPAL_NOT_AUTHORIZED');
    await assert.rejects(rollbackLatest(pool),/CATERING_CATALOGUE_PUBLICATION_ROLLBACK_REQUIRES_REVIEW/);
    const reset = createPostgresDemoResetRepository({ pool: rolePool(roles.reset),
      expectedDatabaseName: name,expectedResetRole: roles.reset });
    assert.equal((await reset.reset({ fixture: DEMO_FIXTURE,checksum: DEMO_FIXTURE_CHECKSUM })).checksum,DEMO_FIXTURE_CHECKSUM);
    for (const table of ['catering_catalogue_reviews','catering_catalogue_review_heads','catering_catalogue_publication_heads']) {
      assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count,0);
    }
    const persona = DEMO_FIXTURE.customerPersonas[0];
    await fixture.auditService.record({ principal: { tenantId: persona.tenantId,userId: persona.userId },
      tenantContext: { tenantId: persona.tenantId },correlationId: id(90),action: 'catering.catalogue.rejected',
      targetType: 'integration',targetId: fixture.integrationId,outcome: 'success',retentionClass: 'business',
      previousState: { revision: 0 },newState: { revision: 1 },metadata: { operation: 'synthetic_audit_only_rollback_probe' } });
    await assert.rejects(rollbackLatest(pool),/CATERING_CATALOGUE_PUBLICATION_ROLLBACK_REQUIRES_REVIEW/);
    assert.equal((await reset.reset({ fixture: DEMO_FIXTURE,checksum: DEMO_FIXTURE_CHECKSUM })).checksum,DEMO_FIXTURE_CHECKSUM);
    await t.test('first publication from empty assignment state retains full300/100/20 supplier catalogue capacity',async () => {
      const empty = await createCateringDeliveryFixture(pool,{ manualCatalogue: true,emptyCateringCatalogue: true });
      const authority = { ...empty.context(),integrationId: empty.integrationId };
      const ports = { registry: empty.registry,auditRepository: empty.auditRepository };
      const policy = { authorizationPolicy: createAuthorizationPolicy(),auditService: empty.auditService };
      const sourceService = createCateringProviderCatalogueService({ ...policy,registry: empty.registry,
        repository: createPostgresCateringProviderCatalogueRepository(customer,ports) });
      const reviewService = createCateringCataloguePublicationService({ ...policy,
        repository: createPostgresCateringCataloguePublicationRepository(customer,ports) });
      const document = source();
      document.items = Array.from({ length: 300 },(_,i) => ({ ...source().items[0],id: `source-item-${i}` }));
      document.packages = Array.from({ length: 100 },(_,i) => ({ ...source().packages[0],id: `source-package-${i}`,
        itemIds: [`source-item-${i}`],variants: Array.from({ length: 20 },(_,j) => ({ ...source().packages[0].variants[0],
          id: `source-variant-${j}` })) }));
      await sourceService.receive({ ...authority,command: { schemaVersion: 1,commandId: id(sequence++),expectedRevision: 0,
        expectedConfigurationRevision: 1,reference: 'Synthetic full-capacity supplier list',attestReceivedFromSupplier: true,
        source: document } });
      const command = intent({ expectedCatalogueRevision: 1,expectedAssignmentRevision: 0,
        items: document.items.map((x,i) => mapping(x.id,`published-item-${i}`)),
        packages: document.packages.map((x,i) => ({ ...mapping(x.id,`published-package-${i}`),
          variants: x.variants.map((v,j) => ({ sourceId: v.id,entryId: `published-variant-${j}`,
            price: money(900),active: true,order: j })) })) });
      const saved = await reviewService.review({ ...authority,command });
      assert.equal(saved.assignmentRevision,1); assert.equal(saved.catalogueRevision,2); assert.equal(saved.publicationRevision,1);
      const reader = createPostgresTenantCatalogueRepository(customer,{ auditRepository: empty.auditRepository });
      const full = await reader.loadCurrent(empty.tenantId);
      assert.equal(full.catalogue.cateringItems.length,300); assert.equal(full.catalogue.cateringPackages.length,100);
      assert.equal(full.catalogue.cateringPackages.every((x) => x.variants.length === 20),true);
      assert.equal(await empty.auditRepository.verifyTenantChain(empty.tenantId),true);
      assert.equal((await reset.reset({ fixture: DEMO_FIXTURE,checksum: DEMO_FIXTURE_CHECKSUM })).checksum,DEMO_FIXTURE_CHECKSUM);
    });
  });
