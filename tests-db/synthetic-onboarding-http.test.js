import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import pg from 'pg';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createProtectedSyntheticCustomerAccess } from '../src/protected-synthetic-customer-access-composition.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createPostgresSyntheticHandoffRepository } from '../src/persistence/postgres/platform-synthetic-handoff-repository.js';
import { createSyntheticHandoffService } from '../src/platform/application/synthetic-handoff-service.js';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

import { unusedProtectedRuntimePort,startProtectedRuntimeProcess,exchangeProtectedRuntime }
  from './support/protected-runtime-process-fixture.js';

test('owned Customer HTTP imports and activates synthetic customers with current Admin custody and atomic history',async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t);const pools=[];let process;
  function database(url,max=1) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href,2),ownerLease=database(fixture.url.href);
  t.after(async()=>{
    try { if (process) await process.stop();await Promise.all(pools.map(pool=>pool.end())); } finally { await fixture.destroy(); }
  });
  await migrateUp(pool);
  const prior=(await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=63 ORDER BY version')).rows;
  assert.equal(await rollbackLatest(pool),true); // Empty service identity075 before unchanged074/older guards.
  assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before original064 roundtrip.
  assert.equal(await rollbackLatest(pool),true);await migrateUp(pool);
  assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=63 ORDER BY version')).rows,prior);
  const epoch=randomUUID(),protection={ environment: 'int',securityEpoch: epoch },scope={ ...protection,platformSecurityEpoch: 7,
    customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const passwords=['customer','platform'].map(()=>randomBytes(32).toString('hex'));
  for (const [index,surface] of ['customer','platform'].entries()) {
    assert.match(passwords[index],/^[a-f0-9]{64}$/);
    await pool.query(`CREATE ROLE "cm_protected_int_${surface}" LOGIN PASSWORD '${passwords[index]}'`);
  }
  await grantProtectedRuntimeRoles(pool,protection);
  const owner=await createProtectedSyntheticOperatorFixture(pool,ownerLease,{ epoch });
  const generationService=createSyntheticGenerationService({ ...protection,passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,
      { ...protection,calendarEnabled: true,tenantAuditRepository: createPostgresAuditRepository(pool,{ hmacSecret: 't'.repeat(48) }),
        platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(intent),proofContext=>generationService.replace({
    proofContext,intent,correlationId: randomUUID() }));
  const url=new URL(fixture.url);url.username='cm_protected_int_customer';url.password=passwords[0];
  const customerPool=database(url.href),leasePool=database(url.href);
  const customer=createProtectedSyntheticCustomerAccess({ pool: customerPool,leasePool,scope,browserSecret: 'h'.repeat(48),
    sourceSecret: 'b'.repeat(48),auditHmacSecret: 't'.repeat(48),csrfSecret: 's'.repeat(48) });
  const binding=createSyntheticHandoffBrowserBinding({ scope,secret: 'h'.repeat(48) });t.after(()=>binding.destroy());
  const handoff=createSyntheticHandoffService({ scope,browserBinding: binding,passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticHandoffRepository(pool,
      { scope,browserBinding: binding,platformAuditRepository: owner.auditRepository }) });
  async function admit(slot,role) {
    const start=await customer.start('127.0.0.1');assert.equal(start.status,'started');
    const intent={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,generationId: generation.generationId,slot,role };
    const operationHash=await owner.scopes.withShared(()=>handoff.operationHash({ principal: owner.current().principal,intent }));
    const redirect=await owner.executeWithContinuation(operationHash,proofContext=>handoff.approve({
      proofContext,intent,correlationId: randomUUID() }));
    const callback={ flowId: start.flowId,state: start.state,browserToken: start.browserToken,
      code: new URL(redirect.location).searchParams.get('code') };
    const confirmation=await customer.callback(callback),choice=await customer.confirmation({ ...callback,
      completion: confirmation.completion });
    const session=await customer.complete({ flowId: start.flowId,browserToken: start.browserToken,
      completion: confirmation.completion,csrfToken: choice.csrfToken,request: { headers: {} },correlationId: randomUUID() });
    assert.ok(await customer.sessionService.resolvePrincipal({ headers: { cookie: session.setCookie.split(';')[0] } }));return session;
  }
  const customerClientId=randomUUID(),platformClientId=randomUUID();
  const environment={ NODE_ENV: 'production',NODE_EXTRA_CA_CERTS: fixture.caPath,
    PROTECTED_ENVIRONMENT: 'int',PROTECTED_SECURITY_EPOCH: epoch,PROTECTED_PLATFORM_SECURITY_EPOCH: '7',
    PROTECTED_API_COMMIT: 'a'.repeat(40),PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),PROTECTED_SERVICE_VERSION: '1.0.0',
    PROTECTED_DATABASE_POOL_MAX: '1',PROTECTED_LEASE_POOL_MAX: '1',
    PROTECTED_CUSTOMER_ORIGIN: scope.customerOrigin,PROTECTED_PLATFORM_ORIGIN: scope.platformOrigin,
    PROTECTED_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),
    PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]),
    PROTECTED_CUSTOMER_DATABASE_URL: url.href,PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: customerClientId,
    PROTECTED_PEER_ENTRA_CLIENT_ID: platformClientId,PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'g'.repeat(48),
    PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'n'.repeat(48),PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),
    PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),PROTECTED_CUSTOMER_HOST: '127.0.0.1',
    PROTECTED_CUSTOMER_PORT: String(await unusedProtectedRuntimePort()),PROTECTED_SYNTHETIC_ENABLED: 'true',
    PROTECTED_HANDOFF_SECRET: 'h'.repeat(48) };
  process=await startProtectedRuntimeProcess('customer',environment);assert.equal(process.outcome.type,'listening');
  const root='/api/v1/integrations/synthetic-calendar';
  const exchange=(path,options)=>exchangeProtectedRuntime('customer',process.outcome.port,path,options);
  const admin=await admit('fabrikam','tenant_admin'),cookie=admin.setCookie.split(';')[0];
  const session=await exchange('/api/v1/session',{ headers: { cookie } });assert.equal(session.status,200);
  const csrf=JSON.parse(session.text).csrfToken,tenantId=admin.principal.tenantId;
  const lifecycleBaseline=(await pool.query(`SELECT count(*)::int AS count FROM audit_events
    WHERE tenant_id=$1 AND action='tenant.lifecycle.changed'`,[tenantId])).rows[0].count;assert.ok(lifecycleBaseline>=1);
  const call=(path,{ method='GET',body,headers={} }={})=>exchange(path,{ method,body,
    headers: { cookie,...(method==='POST' ? { 'x-csrf-token': csrf } : {}),...headers } });
  const mode=await call('/api/v1/tenant/runtime');assert.equal(mode.status,200);
  assert.equal(JSON.parse(mode.text).mode,'synthetic');assert.equal(JSON.parse(mode.text).provider,'synthetic_calendar');
  const first=await call(root);assert.equal(first.status,200);const initial=JSON.parse(first.text);
  assert.equal(initial.mode,'synthetic');assert.equal(initial.provider,'synthetic_calendar');
  assert.equal(initial.microsoftConnection,'not_applicable');assert.equal(initial.tenantStatus,'onboarding');
  assert.equal(initial.roomCount,0);assert.equal(initial.readiness.ready,false);assert.equal(initial.candidates.length,2);
  const input={ expectedRevision: initial.locationsRevision,selectedKeys: ['workshop','focus'] };
  assert.equal((await call(root+'/rooms/import',{ method: 'POST',body: input,
    headers: { 'x-csrf-token': 'wrong' } })).status,403);
  assert.equal((await call(root+'/rooms/import',{ method: 'POST',body: { ...input,tenantId: randomUUID() } })).status,400);
  assert.equal((await call(root+'/rooms/import',{ method: 'POST',body: { ...input,selectedKeys: ['foreign'] } })).status,400);
  assert.equal((await call(root+'/rooms/import',{ method: 'POST',body: input,
    headers: { origin: scope.platformOrigin } })).status,403);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM rooms WHERE tenant_id=$1',[tenantId])).rows[0].n,0);
  const imported=await call(root+'/rooms/import',{ method: 'POST',body: input });
  if (imported.status!==200) t.diagnostic(`Onboarding import code: ${JSON.parse(imported.text).error?.code}; `
    +`privilege failures: ${fixture.permissionFailures().join(',')}`);
  assert.equal(imported.status,200,JSON.parse(imported.text).error?.code);const current=JSON.parse(imported.text);
  assert.equal(current.importedCount,2);assert.equal(current.roomCount,2);assert.equal(current.boundRoomCount,2);
  assert.equal(current.locationsRevision,initial.locationsRevision+1);assert.equal(current.readiness.ready,true);
  assert.equal(current.candidates.every(row=>row.imported),true);
  assert.equal((await call(root+'/rooms/import',{ method: 'POST',body: input })).status,409);
  assert.equal((await call(root+'/rooms/import',{ method: 'POST',body: { ...input,
    expectedRevision: current.locationsRevision } })).status,200);
  const lifecycle=(expectedStatus,targetStatus,expectedRevision=current.locationsRevision)=>call(root+'/lifecycle/transitions',
    { method: 'POST',body: { expectedStatus,targetStatus,expectedRevision } });
  assert.equal((await lifecycle('onboarding','active')).status,400);
  assert.equal((await lifecycle('onboarding','ready',initial.locationsRevision)).status,409);
  assert.equal((await lifecycle('onboarding','ready')).status,200);
  const active=await lifecycle('ready','active');assert.equal(active.status,200,JSON.parse(active.text).error?.code);
  assert.equal(JSON.parse(active.text).tenantStatus,'active');
  const microsoft=await call('/api/v1/integrations/microsoft365');assert.equal(microsoft.status,409);
  assert.equal(JSON.parse(microsoft.text).error.code,'MICROSOFT365_REAL_TENANT_REQUIRED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_identity_bindings WHERE tenant_id=$1',[tenantId])).rows[0].n,0);
  const counts=(await pool.query(`SELECT (SELECT count(*)::int FROM rooms WHERE tenant_id=$1) AS rooms,
    (SELECT count(*)::int FROM synthetic_calendar_resources WHERE tenant_id=$1) AS resources,
    (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND action='tenant.configuration.changed'
      AND (new_state->>'importedCount')::int=2) AS imports,
    (SELECT count(*)::int-$2::int FROM audit_events WHERE tenant_id=$1 AND action='tenant.lifecycle.changed') AS lifecycle`,
  [tenantId,lifecycleBaseline])).rows[0];
  assert.deepEqual(counts,{ rooms: 2,resources: 2,imports: 1,lifecycle: 2 });
  const audit=createPostgresAuditRepository(pool,{ hmacSecret: 't'.repeat(48) });assert.equal(await audit.verifyTenantChain(tenantId),true);
  const contoso=await admit('contoso','tenant_admin'),contosoCookie=contoso.setCookie.split(';')[0];
  assert.equal((await call(root)).status,401,'a fresh unrelated Platform assertion invalidates the prior delegated source');
  const contosoSession=await exchange('/api/v1/session',{ headers: { cookie: contosoCookie } });assert.equal(contosoSession.status,200);
  const ready=await exchange(root,{ headers: { cookie: contosoCookie } });assert.equal(ready.status,200);
  const readyView=JSON.parse(ready.text);assert.equal(readyView.tenantStatus,'ready');assert.equal(readyView.readiness.ready,true);
  const activated=await exchange(root+'/lifecycle/transitions',{ method: 'POST',body: { expectedRevision: readyView.locationsRevision,
    expectedStatus: 'ready',targetStatus: 'active' },headers: { cookie: contosoCookie,
    'x-csrf-token': JSON.parse(contosoSession.text).csrfToken } });
  assert.equal(activated.status,200,JSON.parse(activated.text).error?.code);
  assert.equal(JSON.parse(activated.text).tenantStatus,'active');
  assert.equal(await audit.verifyTenantChain(contoso.principal.tenantId),true);
  const mediaSession=await admit('northwind','employee'),mediaCookie=mediaSession.setCookie.split(';')[0];
  const mediaRoot='/api/v1/tenant/catalogue-media';
  const listed=await exchange(mediaRoot,{ headers: { cookie: mediaCookie } });assert.equal(listed.status,200);
  const assets=JSON.parse(listed.text).assets;assert.ok(assets.length>0 && assets.length<=40);
  assert.ok(assets.some(asset=>asset.ownerKind==='room_plan' && asset.contentType==='image/png'));
  assert.ok(assets.some(asset=>asset.ownerKind.startsWith('catering_') && asset.contentType==='image/webp'));
  assert.equal(listed.text.includes('object_key'),false);assert.equal(listed.text.includes('content_sha256'),false);
  async function image(path,cookie,headers={}) {
    return new Promise((resolve,reject)=>{
      const request=httpRequest({ hostname: '127.0.0.1',port: process.outcome.port,path,headers: {
        host: 'app-int.example.test','sec-fetch-site': 'same-origin',...(cookie ? { cookie } : {}),...headers } },response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));
        response.on('end',()=>resolve({ status: response.statusCode,headers: response.headers,bytes: Buffer.concat(chunks) }));
      });request.on('error',reject);request.setTimeout(10000,()=>request.destroy(new Error('FIXTURE_HTTP_TIMEOUT')));request.end();
    });
  }
  for (const asset of assets) {
    assert.equal(asset.url,`${mediaRoot}/${asset.id}`);
    const actual=await image(asset.url,mediaCookie);assert.equal(actual.status,200);
    const expected=(await pool.query(`SELECT bytes,content_sha256 FROM synthetic_catalogue_media_assets
      WHERE tenant_id=$1 AND id=$2`,[mediaSession.principal.tenantId,asset.id])).rows[0];
    assert.deepEqual(actual.bytes,expected.bytes);
    assert.deepEqual(createHash('sha256').update(actual.bytes).digest(),expected.content_sha256);
    assert.equal(actual.headers['content-type'],asset.contentType);assert.equal(actual.headers['x-content-type-options'],'nosniff');
    assert.match(actual.headers['cache-control'],/private.*must-revalidate/);assert.equal(actual.headers.vary,'Cookie');
    const conditional={ 'if-none-match': actual.headers.etag };
    assert.equal((await image(asset.url,mediaCookie,conditional)).status,304);
    assert.equal((await image(asset.url,null,conditional)).status,401);
    assert.equal((await image(asset.url,cookie,conditional)).status,401,'old source cannot reuse a private cached response');
  }
  const foreign=(await pool.query(`SELECT id FROM synthetic_catalogue_media_assets WHERE tenant_id<>$1 LIMIT 1`,
    [mediaSession.principal.tenantId])).rows[0];assert.ok(foreign);
  assert.equal((await image(`${mediaRoot}/${foreign.id}`,mediaCookie)).status,404);
  assert.equal((await image(`${mediaRoot}/${randomUUID()}`,mediaCookie)).status,404);
  assert.equal((await exchange(mediaRoot+'?tenantId='+tenantId,{ headers: { cookie: mediaCookie } })).status,400);
  assert.equal((await exchange(mediaRoot,{ method: 'POST',body: {},headers: { cookie: mediaCookie } })).status,405);
  const damaged=assets.find(asset=>asset.ownerKind==='catering_item');assert.ok(damaged);
  await pool.query(`UPDATE synthetic_catalogue_media_assets SET object_key='v1/'||tenant_id::text||'/catalogue/'||id::text||'/'
    ||encode(content_sha256,'hex') WHERE tenant_id=$1 AND id=$2`,[mediaSession.principal.tenantId,damaged.id]);
  assert.equal((await image(damaged.url,mediaCookie)).status,503,'unprepared object mode cannot fall back to retained database bytes');
  await pool.query(`UPDATE synthetic_catalogue_media_assets SET object_key=NULL,content_sha256=$3 WHERE tenant_id=$1 AND id=$2`,
    [mediaSession.principal.tenantId,damaged.id,Buffer.alloc(32,9)]);
  assert.equal((await image(damaged.url,mediaCookie)).status,503,'a corrupt digest cannot publish bytes or a 304');
  const plan=assets.find(asset=>asset.ownerKind==='room_plan');
  await pool.query(`UPDATE rooms SET details=details-'floorplanAssetId' WHERE tenant_id=$1 AND id=$2`,
    [mediaSession.principal.tenantId,plan.ownerId]);
  assert.equal((await image(plan.url,mediaCookie,{ 'if-none-match': '*' })).status,404,'detached plan stays concealed');
  await pool.query(`UPDATE rooms SET details=jsonb_set(details,'{floorplanAssetId}',to_jsonb($3::text)),active=false
    WHERE tenant_id=$1 AND id=$2`,[mediaSession.principal.tenantId,plan.ownerId,plan.id]);
  assert.equal((await image(plan.url,mediaCookie)).status,404,'Employee cannot read an inactive Room plan');
  const manager=await admit('northwind','conference_manager'),managerCookie=manager.setCookie.split(';')[0];
  assert.equal((await image(plan.url,managerCookie)).status,200,'current Catalogue Manager can inspect inactive owned media');
  assert.equal((await process.stop()).code,0);
  for (const secret of [fixture.password,...passwords,cookie,contosoCookie,mediaCookie,managerCookie,csrf,'h'.repeat(48),'t'.repeat(48)]) {
    assert.equal(process.logs().includes(secret),false,'actual owned root cannot log custody values');
  }
});
