import { createProductionApplicationService } from '../src/application/production-application-service.js';
import { createTenantCatalogueService } from '../src/application/tenant-catalogue-service.js';
import { createPostgresApplicationRepository } from '../src/persistence/postgres/application-repository.js';
import { createPostgresRequestRepository,resolveCurrentRequestCompositionWithClient
} from '../src/persistence/postgres/request-repository.js';
import { createPostgresMicrosoft365CalendarAuthorityGuard } from '../src/persistence/postgres/calendar-authority-guard.js';
import { readCateringPublishedOffersWithClient,cateringSnapshotRemainsPublishedWithClient,lockCateringPublishedOfferAuthorityWithClient
} from '../src/persistence/postgres/catering-published-offers.js';
import { requestLoadDraft } from '../tests/support/request-load-draft.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringCataloguePublicationService } from '../src/application/catering-catalogue-publication-service.js';
import { createCateringProviderCatalogueService } from '../src/application/catering-provider-catalogue-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadConfig,loadDatabaseConfig } from '../src/config.js';
import { createCateringConfigurationRouteModules } from '../src/catering-configuration-composition.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { createHttpServer } from '../src/server.js';
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
    assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty033 before unchanged032/older reset grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty032 before retained031/older reset grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty031 before unchanged030/older grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty030 before unchanged029/older grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty029 before unchanged028/older guards.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty028 before unchanged027.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty027 before unchanged026.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty overlay026 before025.
    await rollbackLatestDemoMigration(pool,{ roles }); // Protected runtime025 before retained Microsoft024.
    await rollbackLatestDemoMigration(pool,{ roles }); // Microsoft flow024 before retained Customer023.
    await rollbackLatestDemoMigration(pool,{ roles }); // Customer023 before retained enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Original empty publication021.
    assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
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
    assert.equal(await rollbackLatest(pool),true); // Empty enrollment056.
    assert.equal(await rollbackLatest(pool),true); // Original empty publication055.
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
    const fixture = await createCateringDeliveryFixture(pool,{ manualCatalogue: true,pricedRoom: true });
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
    const employeeCatalogue=createPostgresApplicationRepository(customer,{
      auditRepository:fixture.auditRepository,requirePublishedCatering:true,cateringRegistry:fixture.registry,
    });
    const employeeRequests=createPostgresRequestRepository(customer,{
      auditRepository:fixture.auditRepository,requirePublishedCatering:true,cateringRegistry:fixture.registry,
      calendarAuthorityGuard:createPostgresMicrosoft365CalendarAuthorityGuard()});
    const employeeApplication=createProductionApplicationService({
      ...application,repository:employeeCatalogue,requestRepository:employeeRequests,
    });
    const publishedAt=(catalogueRevision)=>withPostgresTransaction(customer,client=>readCateringPublishedOffersWithClient(client,{
      tenantId:fixture.tenantId,registry:fixture.registry,catalogueRevision,
    }),{isolationLevel:'REPEATABLE READ',readOnly:true});
    assert.deepEqual((await publishedAt(2)).itemIds,[]);
    assert.deepEqual((await employeeCatalogue.loadCatalog(fixture.tenantId)).cateringItems,[]);
    assert.deepEqual((await employeeCatalogue.loadCatalogPage({tenantId:fixture.tenantId,section:'cateringItems',limit:1})).entries,[]);
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
    const eligible=await publishedAt(3); assert.deepEqual(eligible.itemIds,['reviewed-coffee']);
    assert.equal(eligible.allowsPackage('reviewed-break','reviewed-standard'),true);
    assert.equal(eligible.allowsPackage('package-a','variant-a'),false);
    const employeeFull=await employeeCatalogue.loadCatalog(fixture.tenantId);
    assert.deepEqual(employeeFull.cateringItems.map(x=>x.id),['reviewed-coffee']);
    assert.deepEqual(employeeFull.cateringPackages.map(x=>x.id),['reviewed-break']);
    for (const [section,expected] of [['cateringItems','reviewed-coffee'],['cateringPackages','reviewed-break']]) {
      const page=await employeeCatalogue.loadCatalogPage({tenantId:fixture.tenantId,section,limit:1});
      assert.equal(page.status,'ready'); assert.deepEqual(page.entries.map(x=>x.id),[expected]);
    }
    const draftFor=(catalogueRevision)=>({...requestLoadDraft({startsAt:new Date(Date.now()+345600000).toISOString(),
      configurationRevisions:{organization:1,locations:1,catalogue:catalogueRevision,bookingPolicies:1,costAllocation:1}}),roomId:'room-a',
      catering:{participantCount:2,packageSelection:{packageId:'reviewed-break',variantId:'reviewed-standard'},
        itemQuantities:[{itemId:'reviewed-coffee',quantity:1}]}});
    const resolveDraft=(draft)=>withPostgresTransaction(customer,client=>resolveCurrentRequestCompositionWithClient(client,{
      tenantId:fixture.tenantId,actorUserId:id(2),draft,schemaVersion:3,operation:'create',capturedAt:new Date().toISOString(),
      requestVersion:1,requirePublishedCatering:true,cateringRegistry:fixture.registry,
    }));
    const allowed=await resolveDraft(draftFor(3)); assert.equal(allowed.status,'ready');
    assert.equal(await withPostgresTransaction(customer,client=>cateringSnapshotRemainsPublishedWithClient(client,{
      tenantId:fixture.tenantId,registry:fixture.registry,snapshot:allowed.snapshot,roomId:'room-a',
    }),{isolationLevel:'REPEATABLE READ',readOnly:true}),true);
    const unpublishedDraft=draftFor(3); unpublishedDraft.catering.packageSelection={packageId:'package-a',variantId:'variant-a'};
    await assert.rejects(resolveDraft(unpublishedDraft),/REQUEST_CONFIGURATION_UNAVAILABLE/);
    const catalogueService=createTenantCatalogueService({...application,repository:catalogue});
    await assert.rejects(withPostgresTransaction(customer,async(client)=>{
      const unrelated=structuredClone(current.catalogue); unrelated.services.push({
        id:'unrelated-service',name:'Synthetic unrelated service',
        description:null,price:money(0),active:true,order:0,siteIds:[],roomIds:[]});
      await catalogueService.update({...context,schemaVersion:1,expectedRevision:3,catalogue:unrelated});
      assert.equal((await publishedAt(4)).allowsItem('reviewed-coffee'),true);
      const changed=structuredClone(unrelated); changed.cateringItems.find(x=>x.id==='reviewed-coffee').price.amountMinor++;
      await catalogueService.update({...context,schemaVersion:1,expectedRevision:4,catalogue:changed});
      assert.equal((await publishedAt(5)).allowsItem('reviewed-coffee'),false);
      assert.deepEqual((await employeeCatalogue.loadCatalogPage({tenantId:fixture.tenantId,section:'cateringItems',limit:1})).entries,[]);
      await assert.rejects(resolveDraft(draftFor(5)),/REQUEST_CONFIGURATION_UNAVAILABLE/);
      assert.equal(await cateringSnapshotRemainsPublishedWithClient(client,{tenantId:fixture.tenantId,registry:fixture.registry,
        snapshot:allowed.snapshot,roomId:'room-a'}),false);
      throw new Error('SYNTHETIC_PUBLICATION_ELIGIBILITY_ROLLBACK');
    },{isolationLevel:'REPEATABLE READ'}),/SYNTHETIC_PUBLICATION_ELIGIBILITY_ROLLBACK/);
    assert.deepEqual(await catalogue.loadCurrent(fixture.tenantId),current);
    const origin = 'http://localhost:3000';
    const config = loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: origin,CATERING_CONFIGURATION_ENABLED: 'true' });
    const modules = createCateringConfigurationRouteModules({ config,...application,
      persistence: { pool: customer,auditRepository: fixture.auditRepository } });
    const tenants = createPostgresTenantRepository(pool);
    const server = createHttpServer({ config,...application,additionalRouteModules: modules,sessionService: fixture.sessionService,
      productionApplicationService:employeeApplication,
      loadTenant: (tenantId) => tenants.findById(tenantId),
      logger: { requestCompleted() {},healthEvaluated() {},securityOutcome() {},unhandledError() {} } });
    await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
    t.after(() => new Promise((resolve,reject) => server.close((error) => error ? reject(error) : resolve())));
    const root = `/api/v1/tenant/catering/provider-catalogues/${fixture.integrationId}`;
    function request(actor,{ suffix = '/review',method = 'GET',command: bodyValue,csrf = null,
      requestOrigin = origin,path:requestPath=null } = {}) {
      return new Promise((resolve,reject) => {
        const body = bodyValue === undefined ? undefined : JSON.stringify(bodyValue);
        const outgoing = http.request({ hostname: '127.0.0.1',port: server.address().port,path: requestPath ?? root+suffix,method,
          headers: { Host: new URL(origin).host,Origin: requestOrigin,
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
    assert.equal((await request(foreign)).status,404);
    const employee = await fixture.sessionService.issue({ tenantId: fixture.tenantId,userId: id(2),roles: ['employee'],
      permissions: [],securityVersion: 1,providerIdentity: { provider: 'test_identity',reference: 'synthetic-review-employee' } },
    { correlationId: id(90) });
    assert.equal((await request(employee)).status,403);
    const employeeSites=await request(employee,{path:'/api/v1/application/catalog?section=sites&limit=1'});
    assert.equal(employeeSites.status,200); const employeeContext=encodeURIComponent(employeeSites.body.context);
    const employeeOffers=await request(employee,{
      path:`/api/v1/application/catalog?section=cateringItems&context=${employeeContext}&limit=1`,
    });
    assert.equal(employeeOffers.status,200); assert.deepEqual(employeeOffers.body.entries.map(x=>x.id),['reviewed-coffee']);
    assert.doesNotMatch(JSON.stringify(employeeOffers.body),/providerPrice|bindings|justification|supplier-coffee|integrationId/);

    const observed = await request(manager); assert.equal(observed.status,200);
    assert.equal(observed.body.canReview,true); assert.equal(observed.body.reviewRevision,1);
    assert.equal(observed.body.publicationRevision,1); assert.equal(observed.body.catalogueRevision,3);
    assert.equal(observed.body.assignmentRevision,2); assert.equal(observed.body.bindings.length,2);
    assert.doesNotMatch(JSON.stringify(observed.body),/actorUserId|providerPrice|justification|sessionId|tenantId/);
    const history = await request(manager,{ suffix: '/reviews' }); assert.equal(history.status,200);
    assert.equal(history.body.revisions.length,1); assert.equal(history.body.revisions[0].decision,'published');
    assert.equal(history.body.revisions[0].justification,first.justification);
    assert.equal((await request(manager,{ suffix: '/review?tenantId=foreign' })).status,400);
    assert.equal((await request(manager,{ suffix: '/review?afterKind=item&afterEntryId=a' })).status,400);
    assert.equal((await request(manager,{ suffix: '/review?publicationRevision=0' })).status,409);
    assert.equal((await request(manager,{ method: 'POST',command: first })).status,403);
    assert.equal((await request(manager,{ method: 'POST',command: first,csrf: manager.csrfToken,
      requestOrigin: 'https://foreign.invalid' })).status,403);
    await receive(1);
    const next = intent({ expectedReviewRevision: 1,expectedSourceRevision: 2,expectedCatalogueRevision: 3,
      expectedAssignmentRevision: 2,expectedPublicationRevision: 1 });
    await assert.rejects(review({ ...next,expectedSourceRevision: 1 }),(error) => error.code.endsWith('SOURCE_CONFLICT'));
    const rejected = { ...next,decision: 'rejected',items: [],packages: [] };
    const rejection = await review(rejected); assert.equal(rejection.reviewRevision,2);
    assert.equal(rejection.publicationRevision,1);
    assert.equal((await publishedAt(3)).allowsItem('reviewed-coffee'),true);
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
    assert.deepEqual((await publishedAt(4)).itemIds,[]);
    assert.deepEqual((await employeeCatalogue.loadCatalog(fixture.tenantId)).cateringPackages,[]);
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
    const finalIntent = intent({ expectedReviewRevision: 3,expectedSourceRevision: 2,expectedCatalogueRevision: 4,
      expectedAssignmentRevision: 3,expectedPublicationRevision: 2,decision: 'rejected',items: [],packages: [] });
    const savedHttp = await request(manager,{ method: 'POST',command: finalIntent,csrf: manager.csrfToken });
    assert.equal(savedHttp.status,200); assert.equal(savedHttp.body.reviewRevision,4); assert.equal(savedHttp.body.publicationRevision,2);
    assert.equal((await request(manager,{ method: 'POST',command: finalIntent,csrf: manager.csrfToken })).body.replayed,true);
    const newest = await request(manager,{ suffix: '/reviews' }); assert.equal(newest.status,200);
    assert.deepEqual(newest.body.revisions.map((x) => x.revision),[4,3,2,1]);
    assert.equal(newest.body.revisions[0].decision,'rejected');
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
      [fixture.tenantId,manager.principal.session.id]);
    await assert.rejects(review(first),(error) => error.code === 'PRINCIPAL_NOT_AUTHORIZED');
    assert.equal((await request(manager)).status,401);
    assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty033 before unchanged032/older reset grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty032 before retained031/older reset grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty031 before unchanged030/older grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty030 before unchanged029/older grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty029 before unchanged028/older guards.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty028 before unchanged027.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty027 before unchanged026.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty overlay026 before025.
    await rollbackLatestDemoMigration(pool,{ roles }); // Protected runtime025 before retained Microsoft024.
    await rollbackLatestDemoMigration(pool,{ roles }); // Microsoft flow024 before retained Customer023.
    await rollbackLatestDemoMigration(pool,{ roles }); // Customer023 before retained enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Enrollment022 before056.
    assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
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
    assert.equal(await rollbackLatest(pool),true); // Empty056; retain the original populated055 probe.
    await assert.rejects(rollbackLatest(pool),/CATERING_CATALOGUE_PUBLICATION_ROLLBACK_REQUIRES_REVIEW/);
    await migrateUp(pool); await migrateDemoUp(pool,{ roles }); // Restore exact057/023 and reset privileges.
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
    assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty033 before unchanged032/older reset grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty032 before retained031/older reset grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty031 before unchanged030/older grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty030 before unchanged029/older grants.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty029 before unchanged028/older guards.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty028 before unchanged027.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty027 before unchanged026.
    await rollbackLatestDemoMigration(pool,{ roles }); // Empty overlay026 before025.
    await rollbackLatestDemoMigration(pool,{ roles }); // Protected runtime025 before retained Microsoft024.
    await rollbackLatestDemoMigration(pool,{ roles }); // Microsoft flow024 before retained Customer023.
    await rollbackLatestDemoMigration(pool,{ roles }); // Customer023 before retained enrollment022.
    await rollbackLatestDemoMigration(pool,{ roles }); // Enrollment022 before056.
    assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
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
    assert.equal(await rollbackLatest(pool),true); // Empty056; retain the original populated055 probe.
    await assert.rejects(rollbackLatest(pool),/CATERING_CATALOGUE_PUBLICATION_ROLLBACK_REQUIRES_REVIEW/);
    await migrateUp(pool); await migrateDemoUp(pool,{ roles }); // Restore exact057/023 and reset privileges.
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
      let afterBinding = null; const allBindings = [];
      do {
        const query = afterBinding === null ? ''
          : `?afterKind=${afterBinding.kind}&afterEntryId=${afterBinding.entryId}&publicationRevision=1`;
        const response = await request(empty.manager,{ suffix: '/review'+query }); assert.equal(response.status,200);
        assert.equal(response.body.sourceRevision,1); assert.equal(response.body.assignmentRevision,1);
        assert.equal(response.body.bindings.length>0 && response.body.bindings.length<=5,true);
        allBindings.push(...response.body.bindings.map((x) => `${x.kind}:${x.entryId}`));
        afterBinding=response.body.nextAfterBinding;
      } while (afterBinding !== null);
      assert.equal(allBindings.length,400); assert.equal(new Set(allBindings).size,400);
      const fullIndex=await withPostgresTransaction(customer,client=>readCateringPublishedOffersWithClient(client,{
        tenantId:empty.tenantId,registry:empty.registry,catalogueRevision:2,
      }),{isolationLevel:'REPEATABLE READ',readOnly:true});
      assert.equal(fullIndex.itemIds.length,300); assert.equal(fullIndex.packages.length,100);
      assert.equal(fullIndex.packages.every(x=>x.variantIds.length===20),true);
      const fullProjection=await employeeCatalogue.loadCatalog(empty.tenantId);
      assert.equal(fullProjection.cateringItems.length,300); assert.equal(fullProjection.cateringPackages.length,100);
      assert.equal(fullProjection.cateringPackages.every(x=>x.variants.length===20),true);
      let disablePending=Promise.resolve();
      try {
        await withPostgresTransaction(customer,async(client)=>{
          await client.query('SELECT id FROM tenants WHERE id=$1 FOR SHARE',[empty.tenantId]);
          await lockCateringPublishedOfferAuthorityWithClient(client,empty.tenantId);
          const holder=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          disablePending=empty.setOrderCapability(false);
          const deadline=Date.now()+5000; let blocked=false;
          do {
            blocked=(await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid))) AS blocked`,[holder])).rows[0].blocked;
            if (!blocked) await new Promise(resolve=>setTimeout(resolve,20));
          } while (!blocked && Date.now()<deadline);
          assert.equal(blocked,true,'Configuration update must wait for the final current-publication authority fence');
          assert.equal((await readCateringPublishedOffersWithClient(client,{
            tenantId:empty.tenantId,registry:empty.registry,catalogueRevision:2,
          })).itemIds.length,300);
        });
      } finally { await disablePending; }
      const disabled=await withPostgresTransaction(customer,client=>readCateringPublishedOffersWithClient(client,{
        tenantId:empty.tenantId,registry:empty.registry,catalogueRevision:2,
      }),{isolationLevel:'REPEATABLE READ',readOnly:true});
      assert.deepEqual(disabled.itemIds,[]); assert.deepEqual(disabled.packages,[]);


      assert.equal((await reset.reset({ fixture: DEMO_FIXTURE,checksum: DEMO_FIXTURE_CHECKSUM })).checksum,DEMO_FIXTURE_CHECKSUM);
    });
  });
