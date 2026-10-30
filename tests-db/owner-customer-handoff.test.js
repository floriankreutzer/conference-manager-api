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
import { deriveProtectedAuthenticationFlowSecret } from '../src/identity/protected-authentication-flow-secret.js';
import { createProtectedOwnerMicrosoftFixture } from './support/protected-owner-microsoft-fixture.js';
import { unusedProtectedRuntimePort,startProtectedRuntimeProcess,exchangeProtectedRuntime }
  from './support/protected-runtime-process-fixture.js';

const headers=cookie=>({ headers: { cookie: cookie.split(';')[0] } });

test('native designated owner REAL handoff creates only own identity, preserves role switches and rechecks every write source',async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),pools=[],children=[];
  function database(url) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max: 1,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href),leasePool=database(fixture.url.href);
  t.after(async()=>{
    try { for (const child of children) await child.stop(); }
    finally { try { await Promise.all(pools.map(pool=>pool.end())); } finally { await fixture.destroy(); } }
  });
  await migrateUp(pool);
  const prior=(await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=71 ORDER BY version')).rows;
  assert.equal(await rollbackLatest(pool),true); // Empty service identity075 before unchanged074/older guards.
  assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before the original empty072 rollback.
  assert.equal(await rollbackLatest(pool),true);await migrateUp(pool);
  assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=71 ORDER BY version')).rows,prior);
  const epoch=randomUUID(),tenantId=randomUUID(),foreignTenant=randomUUID();
  const scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
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
    runtimeLeasePool: platformLease,transactionSecret: deriveProtectedAuthenticationFlowSecret({
      ...protection,secret: 'o'.repeat(48),purpose: 'platform-microsoft-flow' }) });
  const customerScopes=createPostgresProtectedRuntimeExecutionScopes({ pool: customerPool,leasePool: customerLease,...protection });
  const audit=createPostgresAuditRepository(platformPool,{ hmacSecret: 't'.repeat(48) });
  const browserSecret='h'.repeat(48),binding=createOwnerCustomerHandoffBrowserBinding({ scope,secret: browserSecret });
  t.after(()=>binding.destroy());
  const service=createOwnerCustomerAccessService({ scope,browserBinding: binding,microsoftOperationService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresPlatformOwnerCustomerHandoffRepository(platformPool,
      { scope,browserBinding: binding,platformAuditRepository: owner.auditRepository,tenantAuditRepository: audit }) });
  const customer=createProtectedOwnerCustomerAccess({ pool: customerPool,leasePool: customerLease,scope,
    browserSecret,sourceSecret: 'b'.repeat(48),
    auditHmacSecret: 't'.repeat(48),csrfSecret: 's'.repeat(48),fallbackSessionService: { resolvePrincipal: async()=>null } });
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
  // Tenant Admin is exercised through both actual HTTP roots below. These
  // two admissions plus the two negative ceremonies retain the five-proof cap.
  for (const role of ['employee','conference_manager']) {
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
  const foreignOwnId=ownerCustomerUserId({ environment: 'int',operatorId: owner.operatorId,tenantId: foreignTenant });
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Pre-existing Customer identity')",
    [foreignTenant,foreignOwnId]);
  const collision=await customer.start('127.0.0.3');
  await assert.rejects(approve(collision,'employee',foreignTenant));
  assert.equal((await pool.query('SELECT display_name FROM users WHERE tenant_id=$1 AND id=$2',
    [foreignTenant,foreignOwnId])).rows[0].display_name,'Pre-existing Customer identity');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_owner_customer_users WHERE tenant_id=$1',
    [foreignTenant])).rows[0].count,0);
  await pool.query('UPDATE users SET active=false,security_version=security_version+1 WHERE tenant_id=$1 AND id=$2',[tenantId,ownId]);
  assert.equal(await customer.sessionService.resolvePrincipal(headers(previous.setCookie)),null);
  const suspended=await customer.start('127.0.0.4');await assert.rejects(approve(suspended,'tenant_admin'));
  assert.equal((await pool.query('SELECT active FROM users WHERE tenant_id=$1 AND id=$2',[tenantId,ownId])).rows[0].active,false);
  // Only this isolated database-owner fixture restores its own test User. The
  // handoff never changes active state; a fresh exact approval is still needed.
  await pool.query('UPDATE users SET active=true,security_version=security_version+1 WHERE tenant_id=$1 AND id=$2',[tenantId,ownId]);
  assert.equal(await customer.sessionService.resolvePrincipal(headers(previous.setCookie)),null);
  assert.equal(previous.principal.userId,ownId);
  assert.equal(await audit.verifyTenantChain(tenantId),true);assert.ok(await owner.auditRepository.isReady());
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_passkey_credentials')).rows[0].count,0);
  for (const sql of ['TRUNCATE owner_customer_handoffs','TRUNCATE platform_owner_customer_users',
    'UPDATE platform_owner_customer_users SET created_at=created_at',
    `UPDATE sessions SET roles=ARRAY['employee'] WHERE id='${previous.principal.session.id}'`]) {
    await assert.rejects(pool.query(sql));
  }
  assert.equal(await rollbackLatest(pool),true); // Empty service identity075 before unchanged074/older guards.
  assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged populated072 recovery guard.
  await assert.rejects(rollbackLatest(pool),/OWNER_CUSTOMER_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
  await migrateUp(pool); // Restore current readiness before exercising both actual HTTP roots.
  const common={ NODE_ENV: 'production',NODE_EXTRA_CA_CERTS: fixture.caPath,PROTECTED_ENVIRONMENT: 'int',
    PROTECTED_SECURITY_EPOCH: epoch,PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_API_COMMIT: 'a'.repeat(40),
    PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),PROTECTED_SERVICE_VERSION: '1.0.0',PROTECTED_DATABASE_POOL_MAX: '1',
    PROTECTED_LEASE_POOL_MAX: '1',PROTECTED_CUSTOMER_ORIGIN: scope.customerOrigin,PROTECTED_PLATFORM_ORIGIN: scope.platformOrigin,
    PROTECTED_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),
    PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED: 'true',
    PROTECTED_OWNER_HANDOFF_SECRET: browserSecret,
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]) };
  function roleUrl(index) {
    const url=new URL(fixture.url);url.username=`cm_protected_int_${index===0 ? 'customer' : 'platform'}`;
    url.password=passwords[index];return url.href;
  }
  const customerClientId=randomUUID(),customerEnv={ ...common,PROTECTED_CUSTOMER_DATABASE_URL: roleUrl(0),
    PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PEER_ENTRA_CLIENT_ID: owner.clientId,
    PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'g'.repeat(48),PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'n'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),
    PROTECTED_CUSTOMER_HOST: '127.0.0.1',PROTECTED_CUSTOMER_PORT: String(await unusedProtectedRuntimePort()) };
  const platformEnv={ ...common,PROTECTED_PLATFORM_DATABASE_URL: roleUrl(1),PROTECTED_PLATFORM_ENTRA_CLIENT_ID: owner.clientId,
    PROTECTED_PEER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PLATFORM_ENTRA_TENANT_ID: owner.directoryId,
    PROTECTED_PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),PROTECTED_PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),
    PROTECTED_PLATFORM_CSRF_SECRET: 'c'.repeat(48),PROTECTED_PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),
    PROTECTED_PLATFORM_CURSOR_SECRET: 'u'.repeat(48),PROTECTED_PLATFORM_OWNER_RECIPIENT: 'Owner@example.test',
    PROTECTED_PLATFORM_ASSURANCE_MODE: 'microsoft_mfa',PROTECTED_PLATFORM_OWNER_HANDOFF_INTENT_SECRET: 'i'.repeat(48),
    PROTECTED_PLATFORM_HOST: '127.0.0.1',PROTECTED_PLATFORM_PORT: String(await unusedProtectedRuntimePort()) };
  const app=await startProtectedRuntimeProcess('customer',customerEnv);children.push(app);
  const ops=await startProtectedRuntimeProcess('platform',platformEnv);children.push(ops);
  assert.equal(app.outcome.type,'listening');assert.equal(ops.outcome.type,'listening');
  assert.equal((await exchangeProtectedRuntime('customer',app.outcome.port,'/api/v1/session',
    { headers: headers(previous.setCookie).headers })).status,401);
  const started=await exchangeProtectedRuntime('customer',app.outcome.port,'/api/v1/auth/owner/start',{ method: 'POST',body: {} });
  assert.equal(started.status,303);assert.match(started.headers['set-cookie'][0],/^cm_owner_browser=/);
  const arrival=new URL(started.headers.location);assert.equal(arrival.origin,scope.platformOrigin);
  const arrived=await exchangeProtectedRuntime('platform',ops.outcome.port,arrival.pathname+arrival.search,
    { headers: { origin: null,'sec-fetch-site': 'cross-site' } });
  assert.equal(arrived.status,303);assert.equal(arrived.headers.location,'/?auth=owner_intent');
  const intent=arrived.headers['set-cookie'][0].split(';')[0];
  const currentCookie=owner.current().setCookie.split(';')[0],managed={ cookie: `${currentCookie}; ${intent}` };
  const targets=await exchangeProtectedRuntime('platform',ops.outcome.port,'/api/v1/platform/auth/owner/intent',
    { headers: managed });
  assert.equal(targets.status,200);const targetDto=JSON.parse(targets.text);
  assert.equal(targetDto.status,'confirmation_required');assert.equal(targetDto.tenants.length,2);
  assert.ok(targetDto.tenants.some(target=>target.tenantId===tenantId));
  // Do not contact real Microsoft from the fixture. Invalid caller identity is
  // denied before the actual process can construct any provider challenge.
  const unsafe=await exchangeProtectedRuntime('platform',ops.outcome.port,'/api/v1/platform/auth/owner/options',{
    method: 'POST',body: { tenantId,role: 'employee',userId: ownId },
    headers: { ...managed,'x-csrf-token': owner.current().csrfToken } });assert.equal(unsafe.status,400);
  const httpIntent={ flowId: arrival.searchParams.get('flow'),state: arrival.searchParams.get('state'),
    operatorId: owner.operatorId,tenantId,role: 'tenant_admin' };
  const httpHash=await owner.scopes.withShared(()=>service.operationHash({ principal: owner.current().principal,intent: httpIntent }));
  // The isolated actual MSAL fixture verifies only this exact shared proof.
  // Both final HTTP roots independently execute their production protocol; no
  // business/session issuer is injected into either process.
  const verified=await owner.prepare(httpHash);
  const approved=await exchangeProtectedRuntime('platform',ops.outcome.port,'/api/v1/platform/auth/owner/approve',{
    method: 'POST',form: { csrfToken: owner.current().csrfToken,payload: JSON.stringify({
      tenantId,role: 'tenant_admin',state: verified.state }) },
    headers: { cookie: managed.cookie+'; cm_platform_ms_operation='+verified.cookie } });
  assert.equal(approved.status,303);const approvedLocation=new URL(approved.headers.location);
  assert.equal(approvedLocation.origin,scope.customerOrigin);assert.equal(approvedLocation.pathname,'/api/v1/auth/owner/callback');
  const continued=approved.headers['set-cookie'].find(value=>value.startsWith('cm_platform_session='));
  assert.ok(continued);await owner.acceptContinuation(continued);
  const originalBrowser=started.headers['set-cookie'][0].split(';')[0];
  const wrongBrowser=await exchangeProtectedRuntime('customer',app.outcome.port,approvedLocation.pathname+approvedLocation.search,
    { headers: { origin: null,'sec-fetch-site': 'cross-site' } });
  assert.equal(wrongBrowser.status,303);assert.equal(wrongBrowser.headers.location,'/?auth=authentication_failed');
  const returned=await exchangeProtectedRuntime('customer',app.outcome.port,approvedLocation.pathname+approvedLocation.search,
    { headers: { cookie: originalBrowser,origin: null,'sec-fetch-site': 'cross-site' } });
  assert.equal(returned.status,303);assert.equal(returned.headers.location,'/?auth=owner_confirmation');
  const completionCookie=returned.headers['set-cookie'][0].split(';')[0],flowCookies=originalBrowser+'; '+completionCookie;
  const confirmation=await exchangeProtectedRuntime('customer',app.outcome.port,'/api/v1/auth/owner/confirmation',
    { headers: { cookie: flowCookies+'; '+previous.setCookie.split(';')[0] } });
  assert.equal(confirmation.status,200);const confirmed=JSON.parse(confirmation.text);
  assert.equal(confirmed.accountSwitchRequired,true);assert.equal(confirmed.tenantId,tenantId);
  const logout=await exchangeProtectedRuntime('customer',app.outcome.port,'/api/v1/auth/owner/logout',{
    method: 'POST',body: {},headers: { cookie: flowCookies+'; '+previous.setCookie.split(';')[0],
      'x-csrf-token': confirmed.csrfToken } });assert.equal(logout.status,204);
  const finish=()=>exchangeProtectedRuntime('customer',app.outcome.port,'/api/v1/auth/owner/complete',{
    method: 'POST',form: { csrfToken: confirmed.csrfToken },headers: { cookie: flowCookies } });
  const wrongCsrf=await exchangeProtectedRuntime('customer',app.outcome.port,'/api/v1/auth/owner/complete',{
    method: 'POST',form: { csrfToken: '0'.repeat(64) },headers: { cookie: flowCookies } });assert.equal(wrongCsrf.status,401);
  const completed=await finish();assert.equal(completed.status,303);assert.equal(completed.headers.location,'/');
  const customerContinuation=completed.headers['set-cookie'].find(value=>value.startsWith('cm_session='));
  assert.ok(customerContinuation);const actual=await customer.sessionService.resolvePrincipal(headers(customerContinuation));
  assert.ok(actual);assert.equal(actual.userId,ownId);assert.deepEqual(actual.roles,['employee','tenant_admin']);
  previous={ principal: actual,setCookie: customerContinuation };assert.equal((await finish()).status,401);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_owner_customer_users')).rows[0].count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM tenant_user_roles WHERE user_id=$1',[ownId])).rows[0].count,0);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM platform_microsoft_operation_proofs
    WHERE expires_at>clock_timestamp()`)).rows[0].count,5);
  await assert.rejects(owner.prepare('a'.repeat(64)),{ code: 'PLATFORM_MICROSOFT_OPERATION_REJECTED' });

  assert.equal((await app.stop()).code,0);assert.equal((await ops.stop()).code,0);
  async function write(principal) {
    return customerScopes.withShared(()=>writes.run(async()=>{
      writes.observe(principal);
      return withPostgresTransaction(customerPool,async client=>{
        const result=await client.query("UPDATE tenants SET display_name='Owner changed Customer' WHERE id=$1 RETURNING id",[tenantId]);
        return result.rowCount;
      });
    }));
  }
  const blocking=await pool.connect();
  try {
    await blocking.query('BEGIN');await blocking.query('SELECT id FROM platform_sessions WHERE id=$1 FOR UPDATE',
      [owner.current().principal.session.id]);
    await assert.rejects(write(previous.principal),/AUTHORIZATION_DENIED/);
  } finally { await blocking.query('ROLLBACK');blocking.release(); }
  assert.equal(await write(previous.principal),1);
  let entered,release,networkCalls=0;
  const providerEntered=new Promise(resolve=>{ entered=resolve; }),providerRelease=new Promise(resolve=>{ release=resolve; });
  const network=async()=>{ networkCalls++;entered();await providerRelease;return 'isolated-provider-result'; };
  const provider=writes.providerClient({ redirectUri: scope.customerOrigin+'/provider/callback',adminConsentUrl: ()=>null,
    discoverRooms: network,lookupFreeBusy: network,createCalendarEvent: network,updateCalendarEvent: network,
    cancelCalendarEvent: network,verifyBasePermissions: network });
  const attempt=customerScopes.withShared(()=>writes.run(async()=>{
    writes.observe(previous.principal);return provider.createCalendarEvent({});
  }));
  try {
    await Promise.race([providerEntered,attempt.then(()=>{ throw new Error('OWNER_PROVIDER_ENTRY_NOT_OBSERVED'); })]);
    await assert.rejects(pool.query('SELECT id FROM platform_sessions WHERE id=$1 FOR UPDATE NOWAIT',
      [owner.current().principal.session.id]),{ code: '55P03' });
  } finally { release(); }
  assert.equal(await attempt,'isolated-provider-result');assert.equal(networkCalls,1);
  await owner.sessions.revoke(owner.current().principal);
  assert.equal(await customer.sessionService.resolvePrincipal(headers(previous.setCookie)),null);
  await assert.rejects(write(previous.principal),/AUTHORIZATION_DENIED/);
  await assert.rejects(customerScopes.withShared(()=>writes.run(async()=>{
    writes.observe(previous.principal);return provider.createCalendarEvent({});
  })),/AUTHORIZATION_DENIED/);
  assert.equal(networkCalls,1);
  assert.equal((await pool.query('SELECT display_name FROM tenants WHERE id=$1',[tenantId])).rows[0].display_name,
    'Owner changed Customer');
  const restarted=await startProtectedRuntimeProcess('customer',customerEnv);children.push(restarted);
  assert.equal(restarted.outcome.type,'listening');
  assert.equal((await exchangeProtectedRuntime('customer',restarted.outcome.port,'/api/v1/session',
    { headers: headers(previous.setCookie).headers })).status,401);assert.equal((await restarted.stop()).code,0);
  for (const value of [fixture.password,...passwords,previous.setCookie.split(';')[0],currentCookie,intent,
    continued.split(';')[0],verified.cookie]) {
    assert.equal(children.some(child=>child.logs().includes(value)),false,'owner root logs exclude private fixture custody');
  }
});
