import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresProtectedRuntimeReadiness } from '../src/persistence/postgres/protected-runtime-readiness.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { createProtectedOwnerCustomerAccess } from '../src/protected-owner-customer-access-composition.js';
import { createOwnerCustomerHandoffBrowserBinding } from '../src/identity/owner-customer-handoff-browser-binding.js';
import { createPostgresPlatformOwnerCustomerHandoffRepository }
  from '../src/persistence/postgres/platform-owner-customer-handoff-repository.js';
import { createOwnerCustomerAccessService } from '../src/platform/application/owner-customer-access-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresOwnerCustomerAccessRepository } from '../src/persistence/postgres/owner-customer-access-repository.js';
import { createProtectedOwnerCustomerWriteCustody } from '../src/protected-owner-customer-write-composition.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { ownerCustomerUserId } from '../src/domain/owner-customer-handoff.js';
import { createProtectedOwnerMicrosoftFixture } from './support/protected-owner-microsoft-fixture.js';

const headers=cookie=>({ headers: { cookie: cookie.split(';')[0] } });

test('native designated owner REAL handoff creates only own identity, preserves role switches and rechecks every write source',async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),pools=[];
  function database(url) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max: 1,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href),leasePool=database(fixture.url.href);
  t.after(async()=>{ try { await Promise.all(pools.map(pool=>pool.end())); } finally { await fixture.destroy(); } });
  await migrateUp(pool);
  const prior=(await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=71 ORDER BY version')).rows;
  assert.equal(await rollbackLatest(pool),true);await migrateUp(pool);
  assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=71 ORDER BY version')).rows,prior);
  const epoch=randomUUID(),tenantId=randomUUID(),foreignTenant=randomUUID();
  const scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    customerOrigin: 'https://127.0.0.1',platformOrigin: 'https://ops-int.example.com' };
  const protection={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  for (const target of [tenantId,foreignTenant]) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Own REAL Customer','active')",[target]);
    await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[target]);
  }
  const passwords=['customer','platform'].map(()=>randomBytes(32).toString('hex'));
  for (const [index,surface] of ['customer','platform'].entries()) {
    assert.match(passwords[index],/^[a-f0-9]{64}$/);
    await pool.query(`CREATE ROLE "cm_protected_int_${surface}" LOGIN PASSWORD '${passwords[index]}'`);
  }
  await grantProtectedRuntimeRoles(pool,protection);
  function rolePools(surface,index) {
    const url=new URL(fixture.url);url.username=`cm_protected_int_${surface}`;url.password=passwords[index];
    return [database(url.href),database(url.href)];
  }
  const [customerPool,customerLease]=rolePools('customer',0),[platformPool,platformLease]=rolePools('platform',1);
  for (const [surface,business,lease] of [['customer',customerPool,customerLease],['platform',platformPool,platformLease]]) {
    assert.equal(await createPostgresProtectedRuntimeReadiness(business,{ ...protection,surface,leasePool: lease }).isReady(),true);
    const actual=(await business.query(`SELECT current_user AS role,ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()`)).rows[0];
    assert.equal(actual.role,`cm_protected_int_${surface}`);assert.equal(actual.ssl,true);
  }
  for (const sql of ['SELECT token_hash FROM platform_sessions','SELECT nonce_hash FROM platform_microsoft_operation_proofs',
    'SELECT browser_hash FROM platform_microsoft_operation_proofs','UPDATE platform_operators SET status=status',
    'INSERT INTO platform_owner_customer_users DEFAULT VALUES']) {
    await assert.rejects(customerPool.query(sql),{ code: '42501' });
  }
  const immutableRights=(await platformPool.query(`SELECT
    has_table_privilege(current_user,'platform_owner_customer_users','SELECT') AS readable,
    has_table_privilege(current_user,'platform_owner_customer_users','INSERT') AS creatable,
    has_table_privilege(current_user,'platform_owner_customer_users','UPDATE') AS mutable`)).rows[0];
  assert.deepEqual(immutableRights,{ readable: true,creatable: true,mutable: false });
  const owner=await createProtectedOwnerMicrosoftFixture(pool,leasePool,{ epoch,runtimePool: platformPool,
    runtimeLeasePool: platformLease });
  const customerScopes=createPostgresProtectedRuntimeExecutionScopes({ pool: customerPool,leasePool: customerLease,...protection });
  const audit=createPostgresAuditRepository(platformPool,{ hmacSecret: 'a'.repeat(48) });
  const browserSecret='h'.repeat(48),binding=createOwnerCustomerHandoffBrowserBinding({ scope,secret: browserSecret });
  t.after(()=>binding.destroy());
  const service=createOwnerCustomerAccessService({ scope,browserBinding: binding,microsoftOperationService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresPlatformOwnerCustomerHandoffRepository(platformPool,
      { scope,browserBinding: binding,platformAuditRepository: owner.auditRepository,tenantAuditRepository: audit }) });
  const customer=createProtectedOwnerCustomerAccess({ pool: customerPool,leasePool: customerLease,scope,
    browserSecret,sourceSecret: 'b'.repeat(48),
    auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48),fallbackSessionService: { resolvePrincipal: async()=>null } });
  const custody=createPostgresOwnerCustomerAccessRepository(customerPool,{ scope });
  const writes=createProtectedOwnerCustomerWriteCustody({ pool: customerPool,scope });
  const ownId=ownerCustomerUserId({ environment: 'int',operatorId: owner.operatorId,tenantId });
  async function approve(start,role,target=tenantId) {
    const intent={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,tenantId: target,role };
    const operationHash=await owner.scopes.withShared(()=>service.operationHash({ principal: owner.current().principal,intent }));
    const redirect=await owner.executeWithContinuation(operationHash,proofContext=>service.approve({
      proofContext,intent,correlationId: randomUUID() }));
    const location=new URL(redirect.location);assert.equal(location.origin,scope.customerOrigin);
    assert.equal(location.pathname,'/api/v1/auth/owner/callback');assert.equal(location.searchParams.get('state'),start.state);
    return { flowId: start.flowId,state: start.state,browserToken: start.browserToken,code: location.searchParams.get('code') };
  }
  let previous=null;
  for (const role of ['employee','conference_manager','tenant_admin']) {
    const start=await customer.start(`127.0.0.${previous ? 2 : 1}`);assert.equal(start.status,'started');
    const callback=await approve(start,role);
    if (previous) assert.equal(await customer.sessionService.resolvePrincipal(headers(previous.setCookie)),null);
    await assert.rejects(customer.callback({ ...callback,browserToken: Buffer.alloc(32,9).toString('base64url') }),/DENIED/);
    const pending=await customer.callback(callback),view=await customer.confirmation({ ...callback,completion: pending.completion });
    assert.deepEqual(Object.keys(view).sort(),['csrfToken','role','tenantId','tenantName']);assert.equal(view.tenantId,tenantId);
    const input={ flowId: start.flowId,browserToken: start.browserToken,completion: pending.completion,
      csrfToken: view.csrfToken,request: previous ? headers(previous.setCookie) : { headers: {} },correlationId: randomUUID() };
    await assert.rejects(customer.complete({ ...input,csrfToken: '0'.repeat(64) }),/DENIED/);
    const answers=await Promise.allSettled([customer.complete(input),customer.complete({ ...input,correlationId: randomUUID() })]);
    assert.equal(answers.filter(answer=>answer.status==='fulfilled').length,1);
    const session=answers.find(answer=>answer.status==='fulfilled').value;
    assert.equal(session.principal.userId,ownId);assert.equal(session.principal.providerIdentity.provider,'platform_owner');
    assert.deepEqual(session.principal.roles,role==='employee' ? ['employee'] : ['employee',role]);
    assert.ok(await customer.sessionService.resolvePrincipal(headers(session.setCookie)));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_owner_customer_users')).rows[0].count,1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM tenant_user_roles WHERE user_id=$1',[ownId])).rows[0].count,0);
    await assert.rejects(customer.complete(input),/DENIED/);
    const access=await customerScopes.withShared(()=>custody.resolveCurrentAccess({ ...protection,principal: session.principal }));
    assert.equal(access.kind,'owner_delegation');assert.equal(access.runtime.mode,'real');
    assert.equal(await customerScopes.withShared(()=>custody.resolveCurrentAccess({ ...protection,
      principal: { ...session.principal,tenantId: foreignTenant } })),null);
    previous=session;
  }
  assert.equal(await audit.verifyTenantChain(tenantId),true);assert.ok(await owner.auditRepository.isReady());
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_passkey_credentials')).rows[0].count,0);
  for (const sql of ['TRUNCATE owner_customer_handoffs','TRUNCATE platform_owner_customer_users',
    'UPDATE platform_owner_customer_users SET created_at=created_at',
    `UPDATE sessions SET roles=ARRAY['employee'] WHERE id='${previous.principal.session.id}'`]) {
    await assert.rejects(pool.query(sql));
  }
  await assert.rejects(rollbackLatest(pool),/OWNER_CUSTOMER_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
  async function write(principal) {
    return customerScopes.withShared(()=>writes.run(async()=>{
      writes.observe(principal);
      return withPostgresTransaction(customerPool,async client=>{
        const result=await client.query("UPDATE tenants SET display_name='Owner changed Customer' WHERE id=$1 RETURNING id",[tenantId]);
        return result.rowCount;
      });
    }));
  }
  assert.equal(await write(previous.principal),1);
  await owner.sessions.revoke(owner.current().principal);
  assert.equal(await customer.sessionService.resolvePrincipal(headers(previous.setCookie)),null);
  await assert.rejects(write(previous.principal),/AUTHORIZATION_DENIED/);
  assert.equal((await pool.query('SELECT display_name FROM tenants WHERE id=$1',[tenantId])).rows[0].display_name,
    'Owner changed Customer');
});
