import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
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
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresSyntheticCustomerAccessRepository } from '../src/persistence/postgres/synthetic-customer-access-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

test('restricted current synthetic Admin imports gain technical ownership and local lifecycle never fabricates Microsoft',async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t);const pools=[];
  function database(url,max=1) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href,2),ownerLease=database(fixture.url.href);
  t.after(async()=>{ try { await Promise.all(pools.map(pool=>pool.end())); } finally { await fixture.destroy(); } });
  await migrateUp(pool);
  const prior=(await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=63 ORDER BY version')).rows;
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
      { ...protection,calendarEnabled: true,tenantAuditRepository: createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) }),
        platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(intent),proofContext=>generationService.replace({
    proofContext,intent,correlationId: randomUUID() }));
  const url=new URL(fixture.url);url.username='cm_protected_int_customer';url.password=passwords[0];
  const customerPool=database(url.href),leasePool=database(url.href);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ ...protection,pool: customerPool,leasePool });
  const customer=createProtectedSyntheticCustomerAccess({ pool: customerPool,leasePool,scope,browserSecret: 'h'.repeat(48),
    sourceSecret: 'b'.repeat(48),auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48) });
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
  const access=createPostgresSyntheticCustomerAccessRepository(customerPool,{ scope });
  const lifecycle='SELECT protected_synthetic_lifecycle($1,$2,$3,$4,$5,$6) AS allowed';
  const admin=await admit('fabrikam','tenant_admin'),tenantId=admin.principal.tenantId;
  const revision=Number((await pool.query('SELECT locations_revision FROM tenants WHERE id=$1',[tenantId])).rows[0].locations_revision);
  const mutate=work=>scopes.withShared(()=>withPostgresTransaction(customerPool,async client=>{
    assert.ok(await access.resolveCurrentAccess({ ...protection,principal: admin.principal }));
    assert.equal((await client.query('SELECT protected_lock_synthetic_calendar_source($1,$2,$3) AS allowed',
      ['int',epoch,admin.principal.session.id])).rows[0].allowed,true);
    const result=await work(client);
    assert.ok(await access.resolveCurrentAccess({ ...protection,principal: admin.principal }));return result;
  }));
  const transition=(from,to,version=revision)=>mutate(client=>client.query(lifecycle,
    ['int',epoch,admin.principal.session.id,from,to,version])).then(result=>result.rows[0].allowed);
  assert.equal(await transition('onboarding','ready'),false,'no imported Rooms means not ready');
  await assert.rejects(customerPool.query("UPDATE tenants SET status='active' WHERE id=$1",[tenantId]),{ code: '42501' });
  const siteId=randomUUID(),roomId=randomUUID();
  await mutate(async client=>{
    await client.query("INSERT INTO sites(tenant_id,id,name,active) VALUES($1,$2,'Synthetic import campus',true)",[tenantId,siteId]);
    await client.query("INSERT INTO rooms(tenant_id,id,site_id,name,capacity,active) VALUES($1,$2,$3,'Imported synthetic room',12,true)",
      [tenantId,roomId,siteId]);
  });
  const realTenant=randomUUID(),realSite=randomUUID(),realRoom=randomUUID();
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'REAL provisioning tripwire','active')",[realTenant]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[realTenant]);
  await customerPool.query("INSERT INTO sites(tenant_id,id,name,active) VALUES($1,$2,'REAL site',true)",[realTenant,realSite]);
  await customerPool.query("INSERT INTO rooms(tenant_id,id,site_id,name,capacity,active) VALUES($1,$2,$3,'REAL room',8,true)",
    [realTenant,realRoom,realSite]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM synthetic_calendar_resources WHERE tenant_id=$1',
    [realTenant])).rows[0].n,0);
  const resource=(await pool.query('SELECT * FROM synthetic_calendar_resources WHERE tenant_id=$1 AND room_id=$2',
    [tenantId,roomId])).rows[0];assert.ok(resource);assert.equal(resource.generation_id,generation.generationId);
  await assert.rejects(customerPool.query(`INSERT INTO synthetic_calendar_resources
    (environment,security_epoch,tenant_id,generation_id,integration_id,room_id) VALUES('int',$1,$2,$3,$4,$5)`,
  [epoch,tenantId,generation.generationId,resource.integration_id,roomId]),{ code: '42501' });
  await assert.rejects(customerPool.query('UPDATE synthetic_calendar_resources SET revision=revision+1 WHERE tenant_id=$1',
    [tenantId]),{ code: '42501' });
  assert.equal(await transition('onboarding','active'),false);assert.equal(await transition('onboarding','ready',revision+1),false);
  assert.equal(await transition('onboarding','ready'),true);assert.equal(await transition('onboarding','ready'),false);
  assert.equal(await transition('ready','active'),true);assert.equal(await transition('active','suspended'),false);
  assert.equal((await pool.query('SELECT status FROM tenants WHERE id=$1',[tenantId])).rows[0].status,'active');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_identity_bindings WHERE tenant_id=$1',[tenantId])).rows[0].n,0);
  assert.deepEqual((await pool.query('SELECT provider,status FROM integrations WHERE tenant_id=$1',[tenantId])).rows,
    [{ provider: 'synthetic_calendar',status: 'active' }]);
  await assert.rejects(rollbackLatest(pool),/SYNTHETIC_CALENDAR_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
  const employee=await admit('contoso','employee');
  assert.equal((await customerPool.query(lifecycle,
    ['int',epoch,employee.principal.session.id,'ready','active',1])).rows[0].allowed,false);
  assert.equal((await customerPool.query(lifecycle,
    ['prod',epoch,employee.principal.session.id,'ready','active',1])).rows[0].allowed,false);
  assert.equal((await customerPool.query(lifecycle,['int',randomUUID(),employee.principal.session.id,'ready','active',1]))
    .rows[0].allowed,false);
  assert.equal((await customerPool.query(lifecycle,['int',epoch,randomUUID(),'ready','active',1])).rows[0].allowed,false);
  assert.equal(await customer.sessionService.resolvePrincipal({ headers: { cookie: admin.setCookie.split(';')[0] } }),null);
  for (const name of ['provision_synthetic_room_calendar()',
    'protected_synthetic_lifecycle(text,uuid,uuid,text,text,bigint)']) {
    const policy=(await pool.query(`SELECT prosecdef,proconfig,EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner)))
      acl WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute FROM pg_proc WHERE oid=$1::regprocedure`,[name])).rows[0];
    assert.equal(policy.prosecdef,true);assert.deepEqual(policy.proconfig,['search_path=pg_catalog']);
    assert.equal(policy.public_execute,false);
  }
});
