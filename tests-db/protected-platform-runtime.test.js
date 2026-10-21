import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { createProtectedPlatformSessions } from '../src/platform/identity/protected-platform-sessions.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresProtectedCalendarAuthorityGuard } from '../src/persistence/postgres/protected-calendar-authority-guard.js';
import { createPostgresProtectedTenantRuntimeRepository } from '../src/persistence/postgres/protected-tenant-runtime-repository.js';
import { createPostgresSyntheticCalendarRepository } from '../src/persistence/postgres/synthetic-calendar-repository.js';
import { createSyntheticCalendarProviderFactory } from '../src/integrations/synthetic-calendar-provider.js';
import { createProtectedCalendarProviderFactory } from '../src/integrations/protected-calendar-provider-factory.js';
import { createPostgresSyntheticGenerationDirectoryRepository }
  from '../src/persistence/postgres/platform-synthetic-generation-directory-repository.js';
import { platformPasskeyFixture } from '../tests/support/platform-passkey-fixture.js';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { unusedProtectedRuntimePort,startProtectedRuntimeProcess,exchangeProtectedRuntime }
  from './support/protected-runtime-process-fixture.js';

const pair=value=>value.split(';')[0];
test('native owned TLS max1 processes bind exact P256 customer creation, delegation and preserving reset to restricted runtime roles',
async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),children=[];
  const pool=new pg.Pool({ connectionString: fixture.url.href,ssl: { ca: fixture.certificate,rejectUnauthorized: true },
    max: 2,connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});
  t.after(async()=>{
    try { for (const child of children) await child.stop(); }
    finally { try { await pool.end(); } finally { await fixture.destroy(); } }
  });await migrateUp(pool);
  const epoch=randomUUID(),roles=['cm_protected_int_customer','cm_protected_int_platform'];
  const passwords=roles.map(()=>randomBytes(32).toString('hex'));
  for (const [index,role] of roles.entries()) {
    assert.match(passwords[index],/^[a-f0-9]{64}$/);await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${passwords[index]}'`);
  }
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await grantProtectedRuntimeRoles(pool,{ environment: 'int',securityEpoch: epoch });
  const common={ NODE_ENV: 'production',NODE_EXTRA_CA_CERTS: fixture.caPath,PROTECTED_ENVIRONMENT: 'int',
    PROTECTED_SECURITY_EPOCH: epoch,PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_API_COMMIT: 'a'.repeat(40),
    PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),PROTECTED_SERVICE_VERSION: '1.0.0',
    PROTECTED_DATABASE_POOL_MAX: '1',PROTECTED_LEASE_POOL_MAX: '1',
    PROTECTED_CUSTOMER_ORIGIN: 'https://app-int.example.test',PROTECTED_PLATFORM_ORIGIN: 'https://ops-int.example.com',
    PROTECTED_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),
    PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]) };
  const customerClientId=randomUUID(),platformClientId=randomUUID(),directoryId=randomUUID(),subjectId=randomUUID();
  function database(index) { const url=new URL(fixture.url);url.username=roles[index];url.password=passwords[index];return url.href; }
  const platformEnvironment={ ...common,PROTECTED_PLATFORM_DATABASE_URL: database(1),
    PROTECTED_PEER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PLATFORM_ENTRA_CLIENT_ID: platformClientId,
    PROTECTED_PLATFORM_ENTRA_TENANT_ID: directoryId,PROTECTED_PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),
    PROTECTED_PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),PROTECTED_PLATFORM_CSRF_SECRET: 'c'.repeat(48),
    PROTECTED_PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),PROTECTED_PLATFORM_CURSOR_SECRET: 'u'.repeat(48),
    PROTECTED_PLATFORM_PASSKEY_TRANSACTION_SECRET: 'p'.repeat(48),PROTECTED_PLATFORM_OWNER_RECIPIENT: 'Owner@example.test',
    PROTECTED_PLATFORM_HOST: '127.0.0.1',PROTECTED_PLATFORM_PORT: String(await unusedProtectedRuntimePort()),
    PROTECTED_PLATFORM_ASSURANCE_MODE: 'passkey_setup' };
  // A setup process must not execute any business projection. Its real role
  // deliberately lacks a business source read until this fixture restores it.
  await pool.query('REVOKE SELECT ON tenants FROM cm_protected_int_platform');
  const setup=await startProtectedRuntimeProcess('platform',platformEnvironment);children.push(setup);
  assert.equal(setup.outcome.type,'listening');
  const setupConfig=await exchangeProtectedRuntime('platform',setup.outcome.port,'/api/v1/platform/auth/passkey/configuration');
  assert.equal(setupConfig.status,200);assert.equal(JSON.parse(setupConfig.text).mode,'passkey_setup');
  assert.equal((await exchangeProtectedRuntime('platform',setup.outcome.port,'/api/v1/platform/tenants')).status,404);
  assert.equal((await setup.stop()).code,0);
  await pool.query('GRANT SELECT ON tenants TO cm_protected_int_platform');
  const operatorId=randomUUID(),operatorRoles=['platform_tenant_operator'];
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,scope_mode,roles)
    VALUES($1,$2,$3,$4,'all',$5)`,[operatorId,PLATFORM_ENTRA_PROVIDER,directoryId,subjectId,operatorRoles]);
  const keys=[platformPasskeyFixture({ operatorId }),platformPasskeyFixture({ operatorId })];
  for (const key of keys) await pool.query(`INSERT INTO platform_passkey_credentials
    (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
    VALUES($1,$2,'int',$3,$4,$5,0,false,false)`,
  [randomUUID(),operatorId,key.credential.id,key.credential.publicKey,key.userHandle]);
  const securityVersion=Number((await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',[operatorId]))
    .rows[0].security_version);
  const audit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const sessions=createProtectedPlatformSessions({ repository: createPostgresPlatformSessionRepository(pool,{ auditRepository: audit }),
    environment: 'int',protectedSecurityEpoch: epoch,publicOrigin: common.PROTECTED_PLATFORM_ORIGIN,csrfSecret: 'c'.repeat(48),
    securityEpoch: 7,authenticationMaxAgeSeconds: 300 });
  // Only fixture provisioning occurs outside the owned process. Two actual
  // software P256 keys and the canonical protected session establish test MFA;
  // no Microsoft-primary/provider/verifier/issuer seam enters either root.
  const initial=await sessions.issue({ operatorId,roles: operatorRoles,permissions: permissionsForPlatformRoles(operatorRoles),
    securityVersion,targetScope: { mode: 'all',securityVersion },providerIdentity: { provider: PLATFORM_ENTRA_PROVIDER,
      tenantReference: directoryId,subjectReference: subjectId },
    assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: new Date().toISOString() } });
  const active={ ...platformEnvironment,PROTECTED_PLATFORM_ASSURANCE_MODE: 'application_passkey',
    PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'h'.repeat(48),PROTECTED_PLATFORM_HANDOFF_INTENT_SECRET: 'i'.repeat(48) };
  const platform=await startProtectedRuntimeProcess('platform',active);children.push(platform);
  assert.equal(platform.outcome.type,'listening');
  const customerEnvironment={ ...common,PROTECTED_CUSTOMER_DATABASE_URL: database(0),
    PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: customerClientId,PROTECTED_PEER_ENTRA_CLIENT_ID: platformClientId,
    PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'g'.repeat(48),PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'n'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),
    PROTECTED_CUSTOMER_HOST: '127.0.0.1',PROTECTED_CUSTOMER_PORT: String(await unusedProtectedRuntimePort()),
    PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'h'.repeat(48) };
  const customer=await startProtectedRuntimeProcess('customer',customerEnvironment);children.push(customer);
  assert.equal(customer.outcome.type,'listening');
  const ops=(path,input)=>exchangeProtectedRuntime('platform',platform.outcome.port,path,input);
  const app=(path,input)=>exchangeProtectedRuntime('customer',customer.outcome.port,path,input);
  let cookie=pair(initial.setCookie),csrfToken=initial.csrfToken,counter=0;
  async function current(response) {
    if (response) cookie=pair(response.headers['set-cookie'][0]);
    const view=await ops('/api/v1/platform/session',{ headers: { cookie } });assert.equal(view.status,200);
    const value=JSON.parse(view.text);assert.equal(value.assurance.level,'mfa');csrfToken=value.csrfToken;
  }
  await current();
  const body={ displayName: 'Owned root REAL customer',reason: 'Isolated root acceptance',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,displayName: 'Owned root REAL customer' },
    invitations: [{ recipient: 'Member@example.test',roles: ['conference_manager'],locale: 'de' }] };
  const request={ method: 'POST',body,headers: { cookie,'x-csrf-token': csrfToken,'idempotency-key': randomUUID() } };
  const challenge=await ops('/api/v1/platform/tenants',request);assert.equal(challenge.status,428);
  const pending=JSON.parse(challenge.text);
  const proof=Buffer.from(JSON.stringify({ state: pending.state,response: keys[0].response('get',{
    counter: ++counter,client: { challenge: pending.options.challenge } }) })).toString('base64url');
  const signed={ ...request,headers: { ...request.headers,cookie: `${cookie}; ${pair(challenge.headers['set-cookie'][0])}`,
    'x-platform-passkey-proof': proof } };
  const created=await ops('/api/v1/platform/tenants',signed);assert.equal(created.status,201);
  const real=JSON.parse(created.text);assert.equal(real.invitations.length,2);
  assert.ok(real.invitations.some(row=>row.recipient==='Owner@example.test' && row.roles.includes('tenant_admin')));
  assert.ok(real.invitations.some(row=>row.recipient==='Member@example.test'));
  assert.equal((await ops('/api/v1/platform/tenants',signed)).status,401);await current(created);
  const tenantId=real.tenant.id;
  assert.equal((await pool.query("SELECT mode FROM tenant_runtime_registry WHERE tenant_id=$1",[tenantId])).rows[0].mode,'real');
  const generationPath='/api/v1/platform/synthetic/generation';
  const probePool=new pg.Pool({ connectionString: database(1),ssl: { ca: fixture.certificate,rejectUnauthorized: true },
    max: 1,connectionTimeoutMillis: 2000,statement_timeout: 10000 });
  const probeLease=new pg.Pool({ connectionString: database(1),ssl: { ca: fixture.certificate,rejectUnauthorized: true },
    max: 1,connectionTimeoutMillis: 2000,statement_timeout: 10000 });
  try {
    assert.equal((await probePool.query(`SELECT has_table_privilege(current_user,'tenant_runtime_registry','UPDATE')
      OR has_any_column_privilege(current_user,'tenant_runtime_registry','UPDATE') AS allowed`)).rows[0].allowed,false);
    const scope={ environment: 'int',securityEpoch: epoch };
    const execution=createPostgresProtectedRuntimeExecutionScopes({ ...scope,pool: probePool,leasePool: probeLease });
    const directory=createPostgresSyntheticGenerationDirectoryRepository(probePool,{ ...scope,platformSecurityEpoch: 7 });
    const principal=await sessions.resolvePrincipal({ headers: { cookie } });assert.ok(principal);
    assert.deepEqual(await execution.withShared(()=>directory.current(principal)),
      { generation: null,retainedGenerations: 0,replaceAfter: null,canReplace: true });
  } finally { await Promise.all([probePool.end(),probeLease.end()]); }
  async function replace(expectedGenerationId,expectedRevision) {
    const intent={ expectedGenerationId,expectedRevision };
    const options=await ops(generationPath+'/options',{ method: 'POST',body: intent,
      headers: { cookie,'x-csrf-token': csrfToken } });
    if (options.status!==200) t.diagnostic(`Restricted PostgreSQL privilege failures: ${fixture.permissionFailures().join(',')}`);
    assert.equal(options.status,200,JSON.parse(options.text).error?.code);
    const value=JSON.parse(options.text);
    const result=await ops(generationPath+'/replace',{ method: 'POST',body: { ...intent,state: value.state,
      response: keys[0].response('get',{ counter: ++counter,client: { challenge: value.options.challenge } }) },
    headers: { cookie: `${cookie}; ${pair(options.headers['set-cookie'][0])}`,'x-csrf-token': csrfToken } });
    assert.equal(result.status,200);await current(result);return JSON.parse(result.text).generation;
  }
  const generation=await replace(null,0);assert.equal(generation.tenants.length,3);
  const start=await app('/api/v1/auth/delegation/start',{ method: 'POST',form: {} });assert.equal(start.status,303);
  const target=new URL(start.headers.location),browser=pair(start.headers['set-cookie'][0]);
  const arrival=await ops(target.pathname+target.search,{ headers: { origin: null,'sec-fetch-site': 'cross-site' } });
  assert.equal(arrival.status,303);const intentCookie=pair(arrival.headers['set-cookie'][0]);
  const selection={ generationId: generation.generationId,slot: 'northwind',role: 'tenant_admin' };
  const options=await ops('/api/v1/platform/auth/delegation/options',{ method: 'POST',body: selection,
    headers: { cookie: `${cookie}; ${intentCookie}`,'x-csrf-token': csrfToken } });
  if (options.status!==200) t.diagnostic(`Restricted PostgreSQL privilege failures: ${fixture.permissionFailures().join(',')}`);
  assert.equal(options.status,200,JSON.parse(options.text).error?.code);
  const handoff=JSON.parse(options.text);
  const approved=await ops('/api/v1/platform/auth/delegation/approve',{ method: 'POST',form: { csrfToken,
    payload: JSON.stringify({ ...selection,state: handoff.state,response: keys[0].response('get',{
      counter: ++counter,client: { challenge: handoff.options.challenge } }) }) },
  headers: { cookie: `${cookie}; ${intentCookie}; ${pair(options.headers['set-cookie'][0])}` } });
  assert.equal(approved.status,303);await current(approved);
  const callback=new URL(approved.headers.location);
  const arrived=await app(callback.pathname+callback.search,{ headers: { cookie: browser,origin: null,'sec-fetch-site': 'cross-site' } });
  assert.equal(arrived.status,303);const completionCookie=pair(arrived.headers['set-cookie'][0]);
  const completionCookies=`${browser}; ${completionCookie}`;
  const confirmation=await app('/api/v1/auth/delegation/confirmation',{ headers: { cookie: completionCookies } });
  assert.equal(confirmation.status,200);
  const completed=await app('/api/v1/auth/delegation/complete',{ method: 'POST',
    form: { csrfToken: JSON.parse(confirmation.text).csrfToken },headers: { cookie: completionCookies } });
  assert.equal(completed.status,303);let customerCookie=pair(completed.headers['set-cookie'][0]);
  assert.equal((await app('/api/v1/session',{ headers: { cookie: customerCookie } })).status,200);
  const guarded=await app('/api/v1/integrations/microsoft365',{ headers: { cookie: customerCookie } });
  assert.equal(guarded.status,409);assert.equal(JSON.parse(guarded.text).error.code,'MICROSOFT365_REAL_TENANT_REQUIRED');
  const adminCookie=customerCookie,adminView=JSON.parse((await app('/api/v1/session',{ headers: { cookie: adminCookie } })).text);
  assert.equal((await app('/api/v1/session',{ method: 'DELETE',headers: { cookie: adminCookie,
    'x-csrf-token': adminView.csrfToken } })).status,204);
  assert.equal((await app('/api/v1/session',{ headers: { cookie: adminCookie } })).status,401);
  // A second fresh assertion selects the actual Conference Manager persona.
  const managerStart=await app('/api/v1/auth/delegation/start',{ method: 'POST',form: {} });assert.equal(managerStart.status,303);
  const managerTarget=new URL(managerStart.headers.location),managerBrowser=pair(managerStart.headers['set-cookie'][0]);
  const managerArrival=await ops(managerTarget.pathname+managerTarget.search,
    { headers: { origin: null,'sec-fetch-site': 'cross-site' } });assert.equal(managerArrival.status,303);
  const managerIntent=pair(managerArrival.headers['set-cookie'][0]);
  const managerSelection={ generationId: generation.generationId,slot: 'northwind',role: 'conference_manager' };
  const managerOptions=await ops('/api/v1/platform/auth/delegation/options',{ method: 'POST',body: managerSelection,
    headers: { cookie: `${cookie}; ${managerIntent}`,'x-csrf-token': csrfToken } });assert.equal(managerOptions.status,200);
  const managerChallenge=JSON.parse(managerOptions.text);
  const managerApproved=await ops('/api/v1/platform/auth/delegation/approve',{ method: 'POST',form: { csrfToken,
    payload: JSON.stringify({ ...managerSelection,state: managerChallenge.state,response: keys[0].response('get',{
      counter: ++counter,client: { challenge: managerChallenge.options.challenge } }) }) },
  headers: { cookie: `${cookie}; ${managerIntent}; ${pair(managerOptions.headers['set-cookie'][0])}` } });
  assert.equal(managerApproved.status,303);await current(managerApproved);
  const managerCallback=new URL(managerApproved.headers.location);
  const managerArrived=await app(managerCallback.pathname+managerCallback.search,
    { headers: { cookie: managerBrowser,origin: null,'sec-fetch-site': 'cross-site' } });assert.equal(managerArrived.status,303);
  const managerCompletion=`${managerBrowser}; ${pair(managerArrived.headers['set-cookie'][0])}`;
  const managerConfirmation=await app('/api/v1/auth/delegation/confirmation',{ headers: { cookie: managerCompletion } });
  assert.equal(managerConfirmation.status,200);
  const managerCompleted=await app('/api/v1/auth/delegation/complete',{ method: 'POST',
    form: { csrfToken: JSON.parse(managerConfirmation.text).csrfToken },headers: { cookie: managerCompletion } });
  assert.equal(managerCompleted.status,303);customerCookie=pair(managerCompleted.headers['set-cookie'][0]);
  const managerSession=await app('/api/v1/session',{ headers: { cookie: customerCookie } });assert.equal(managerSession.status,200);
  const managerView=JSON.parse(managerSession.text),syntheticTenant=managerView.tenant.id;
  const resources=(await pool.query(`SELECT count(*)::int AS count FROM synthetic_calendar_resources WHERE tenant_id=$1`,
    [syntheticTenant])).rows[0].count;assert.equal(resources,10);
  const integration=(await pool.query('SELECT provider,status FROM integrations WHERE tenant_id=$1',[syntheticTenant])).rows;
  assert.deepEqual(integration,[{ provider: 'synthetic_calendar',status: 'active' }]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM tenant_identity_bindings WHERE tenant_id=$1',
    [syntheticTenant])).rows[0].count,0);
  const source=(await pool.query(`SELECT session.id,session.tenant_id,session.user_id,session.provider,
    session.provider_identity_reference,session.roles,session.permissions,session.principal_version,session.issued_at,session.expires_at,
    custody.source_platform_session_id FROM sessions session JOIN synthetic_customer_handoffs custody
      ON custody.customer_session_id=session.id WHERE session.tenant_id=$1 AND session.user_id=$2 AND session.revoked_at IS NULL`,
  [syntheticTenant,managerView.user.id])).rows[0];assert.ok(source);
  const guardedPrincipal={ tenantId: source.tenant_id,userId: source.user_id,roles: source.roles,permissions: source.permissions,
    providerIdentity: { provider: source.provider,reference: source.provider_identity_reference },session: { id: source.id,
      issuedAt: source.issued_at.toISOString(),expiresAt: source.expires_at.toISOString(),
      securityVersion: Number(source.principal_version) } };
  const calendarPool=new pg.Pool({ connectionString: database(0),ssl: { ca: fixture.certificate,rejectUnauthorized: true },
    max: 1,connectionTimeoutMillis: 2000,statement_timeout: 10000 });
  const calendarLease=new pg.Pool({ connectionString: database(0),ssl: { ca: fixture.certificate,rejectUnauthorized: true },
    max: 1,connectionTimeoutMillis: 2000,statement_timeout: 10000 });
  try {
    const protection={ environment: 'int',securityEpoch: epoch };
    const scopes=createPostgresProtectedRuntimeExecutionScopes({ ...protection,pool: calendarPool,leasePool: calendarLease });
    const factory=createProtectedCalendarProviderFactory({ ...protection,
      runtimeRepository: createPostgresProtectedTenantRuntimeRepository(calendarPool,{ ...protection,leasePool: calendarLease }),
      syntheticFactory: createSyntheticCalendarProviderFactory({
        repository: createPostgresSyntheticCalendarRepository(calendarPool,protection) }) });
    const actual=(await pool.query(`SELECT id,room_id,starts_at,ends_at FROM requests
      WHERE tenant_id=$1 AND status='In Review' ORDER BY id LIMIT 1`,[syntheticTenant])).rows[0];assert.ok(actual);
    await scopes.withShared(async()=>{
      const provider=await factory.forRoom({ tenantId: syntheticTenant,roomId: actual.room_id });
      const checked=await provider.validateReservation({ tenantId: syntheticTenant,roomId: actual.room_id,requestId: actual.id,
        startsAt: actual.starts_at.toISOString(),endsAt: actual.ends_at.toISOString(),phase: 'final',correlationId: randomUUID() });
      assert.equal(typeof checked.valid,'boolean');
    });
    const guard=createPostgresProtectedCalendarAuthorityGuard(calendarPool,{ ...protection,syntheticScope: { ...protection,
      platformSecurityEpoch: 7,customerOrigin: common.PROTECTED_CUSTOMER_ORIGIN,platformOrigin: common.PROTECTED_PLATFORM_ORIGIN } });
    let entered,release;const seen=new Promise(resolve=>{ entered=resolve; }),hold=new Promise(resolve=>{ release=resolve; });
    const locked=scopes.withShared(()=>withPostgresTransaction(calendarPool,async client=>{
      assert.equal(await guard.lockCustomerMutation(client,{ tenantId: syntheticTenant,principal: guardedPrincipal }),true);
      entered((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await hold;
    }));
    const holderPid=await Promise.race([seen,locked.then(()=>{ throw new Error('FINAL_SOURCE_LOCK_NOT_ENTERED'); })]);
    const revoker=await pool.connect();let revoking;
    try {
      await revoker.query('BEGIN');const pid=(await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      revoking=revoker.query('UPDATE platform_sessions SET revoked_at=clock_timestamp() WHERE id=$1',
        [source.source_platform_session_id]);
      let blocked=false;
      for (let attempt=0;attempt<100;attempt++) {
        const probe=await pool.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked',[pid,holderPid]);
        if (probe.rows[0].blocked) { blocked=true;break; }await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'final source lock must block real concurrent source revocation');
    } finally { release();await locked;try { await revoking;await revoker.query('ROLLBACK'); } finally { revoker.release(); } }
  } finally { await Promise.all([calendarPool.end(),calendarLease.end()]); }
  assert.equal((await app('/api/v1/session',{ headers: { cookie: customerCookie } })).status,200);
  const candidate=(await pool.query(`SELECT request.id,request.request_version FROM requests request
    WHERE request.tenant_id=$1 AND request.status='In Review' AND NOT EXISTS(SELECT 1 FROM requests other
      WHERE other.tenant_id=request.tenant_id AND other.room_id=request.room_id AND other.id<>request.id
        AND other.status='Confirmed' AND other.starts_at<request.ends_at AND other.ends_at>request.starts_at)
    ORDER BY request.id LIMIT 1`,[syntheticTenant])).rows[0];assert.ok(candidate);
  const confirmed=await app(`/api/v1/requests/${candidate.id}/transitions`,{ method: 'POST',body: { transition: 'confirm' },
    headers: { cookie: customerCookie,'x-csrf-token': managerView.csrfToken,'if-match': `"${candidate.request_version}"` } });
  if (confirmed.status!==200) {
    const phases=(await pool.query(`SELECT metadata->>'reasonCode' AS phase FROM audit_events
      WHERE tenant_id=$1 AND target_id=$2 ORDER BY sequence DESC LIMIT 5`,[syntheticTenant,candidate.id])).rows
      .map(row=>row.phase).filter(value=>['provider_unavailable','calendar_write_unavailable','calendar_cleanup_unavailable',
        'calendar_entitlement_unavailable','entitlement_denied'].includes(value));
    t.diagnostic(`Calendar confirmation error: ${JSON.parse(confirmed.text).error?.code}; phases: ${phases.join(',')}; `
      +`privilege failures: ${fixture.permissionFailures().join(',')}`);
  }
  assert.equal(confirmed.status,200,JSON.parse(confirmed.text).error?.code);
  assert.equal(JSON.parse(confirmed.text).request.status,'Confirmed');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM synthetic_calendar_events WHERE tenant_id=$1 AND state='active'",
    [syntheticTenant])).rows[0].count,1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM booking_provider_references WHERE tenant_id=$1 AND state='active'",
    [syntheticTenant])).rows[0].count,1);
  // Actual clock/cooldown, then an independent exact assertion. No time rewrite.
  await new Promise(resolve=>setTimeout(resolve,10100));
  const reset=await replace(generation.generationId,generation.revision);assert.notEqual(reset.generationId,generation.generationId);
  assert.equal((await app('/api/v1/session',{ headers: { cookie: customerCookie } })).status,401);
  const old=generation.tenants.find(row=>row.slot==='northwind').tenantId;
  const preserved=(await pool.query(`SELECT status,(SELECT count(*)::int FROM rooms WHERE tenant_id=tenants.id) AS rooms,
    (SELECT count(*)::int FROM requests WHERE tenant_id=tenants.id) AS requests FROM tenants WHERE id=$1`,[old])).rows[0];
  assert.deepEqual(preserved,{ status: 'archived',rooms: 10,requests: 20 });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM synthetic_calendar_resources WHERE tenant_id=$1',[old]))
    .rows[0].count,10);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM synthetic_calendar_events WHERE tenant_id=$1',[old]))
    .rows[0].count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM customer_member_invitations WHERE tenant_id=$1',[tenantId]))
    .rows[0].count,2);
  assert.equal((await pool.query('SELECT mode FROM tenant_runtime_registry WHERE tenant_id=$1',[tenantId])).rows[0].mode,'real');
  const tenantAudit=createPostgresAuditRepository(pool,{ hmacSecret: 't'.repeat(48) });
  assert.equal(await tenantAudit.verifyTenantChain(tenantId),true);assert.equal(await tenantAudit.verifyTenantChain(old),true);
  assert.equal((await customer.stop()).code,0);assert.equal((await platform.stop()).code,0);
  for (const value of [fixture.password,...passwords,proof,customerCookie,adminCookie,managerBrowser,browser,completionCookie,
    callback.searchParams.get('code')]) {
    assert.equal(children.some(child=>child.logs().includes(value)),false,'owned runtime logs cannot expose proof/custody values');
  }
});
