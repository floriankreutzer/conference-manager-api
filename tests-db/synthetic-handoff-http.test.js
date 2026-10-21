import { createProtectedInvitedCustomerSessions } from '../src/identity/protected-invited-customer-sessions.js';
import { createPostgresProtectedInvitedSessionRepository } from '../src/persistence/postgres/protected-invited-session-repository.js';
import { createPostgresProtectedCustomerAccessRepository } from '../src/persistence/postgres/protected-customer-access-repository.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig,loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { createPostgresPlatformOperatorRepository } from '../src/persistence/postgres/platform-operator-repository.js';
import { createPostgresSyntheticHandoffRepository } from '../src/persistence/postgres/platform-synthetic-handoff-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createProtectedCustomerAuthentication } from '../src/protected-customer-authentication-composition.js';
import { createCustomerAuthenticationComposition } from '../src/customer-authentication-composition.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { readPlatformPasskeyTransactionCookie } from '../src/platform/identity/passkey-auth-cookie.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createPlatformSyntheticHandoffIntentCookie } from '../src/platform/identity/synthetic-handoff-intent-cookie.js';
import { createSyntheticHandoffService } from '../src/platform/application/synthetic-handoff-service.js';
import { createSyntheticHandoffProtocol } from '../src/platform/application/synthetic-handoff-protocol.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { createPlatformSyntheticHandoffRouteModule } from '../src/platform/http/synthetic-handoff-routes.js';
import { createApp } from '../src/app.js';
import { createProtectedHttpExecutionHandler } from '../src/transport/protected-http-execution.js';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { createLogger } from '../src/logger.js';
import { createPlatformLogger } from '../src/platform/http/observability.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

const pair=value=>value.split(';')[0];
test('native max1 two-surface HTTP handoff commits actual P256 continuation and one Customer session, then honors source revocation',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 }),servers=[],logs=[];
  t.after(async()=>{ await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
    await Promise.all([pool.end(),leasePool.end()]); });
  await migrateUp(pool);const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    customerOrigin: 'https://127.0.0.1',platformOrigin: 'https://ops-int.example.com' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const authorizationPolicy=createPlatformAuthorizationPolicy();
  const tenantAudit=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const generationService=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,passkeyService: owner.auth,
    authorizationPolicy,repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
      tenantAuditRepository: tenantAudit,platformAuditRepository: owner.auditRepository }) });
  const generationIntent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(generationIntent),proofContext=>generationService.replace({
    proofContext,intent: generationIntent,correlationId: randomUUID() }));
  const binding=createSyntheticHandoffBrowserBinding({ scope,secret: 'h'.repeat(48) });t.after(()=>binding.destroy());
  const cookieCodec=createPlatformSyntheticHandoffIntentCookie({ scope,secret: 'i'.repeat(48) });t.after(()=>cookieCodec.destroy());
  const handoffService=createSyntheticHandoffService({ scope,browserBinding: binding,passkeyService: owner.auth,authorizationPolicy,
    repository: createPostgresSyntheticHandoffRepository(pool,
      { scope,browserBinding: binding,platformAuditRepository: owner.auditRepository }) });
  const protocol=createSyntheticHandoffProtocol({ handoffService,passkeyService: owner.auth,
    withPreparationScope: owner.scopes.withShared });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',keys: new Map([['initial',Buffer.alloc(32,3)]]),
    lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const customerConfig=Object.freeze({ ...loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: scope.customerOrigin,
    RATE_LIMIT_MAX: '120',CSRF_SECRET: 's'.repeat(48),AUDIT_HMAC_SECRET: 'a'.repeat(48) }),
    deploymentEnvironment: 'int' }),customerPersistence={ pool };
  const customer=createProtectedCustomerAuthentication({ config: customerConfig,persistence: customerPersistence,leasePool,
    ...{ environment: 'int',securityEpoch: epoch },cipher,emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),
    emailSourceSecret: 'b'.repeat(48),synthetic: { platformOrigin: scope.platformOrigin,platformSecurityEpoch: 7,
      browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48) } });
  const { sessionService: customerSessions,onboardingService,entraAuthService }=createCustomerAuthenticationComposition({
    config: customerConfig,persistence: customerPersistence,authenticationFactory: customer.authenticationFactory });
  assert.equal(onboardingService,null);assert.equal(entraAuthService,null);
  assert.equal(customerSessions.issue,undefined);assert.equal(customerSessions.rotate,undefined);
  const real=await createInvitedCustomerFixture(pool,t),protection={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real.tenantId]);
  const realSessions=createProtectedInvitedCustomerSessions({ ...protection,
    sessionRepository: createPostgresProtectedInvitedSessionRepository(pool,{ ...protection,auditRepository: real.auditRepository }),
    accessRepository: createPostgresProtectedCustomerAccessRepository(pool,protection),auditService: real.auditService,
    publicOrigin: scope.customerOrigin,csrfSecret: 's'.repeat(48) });
  const realIdentity={ tenantId: real.tenantId,userId: real.principal.userId,providerIdentity: real.principal.providerIdentity,
    roles: real.principal.roles,permissions: real.principal.permissions,securityVersion: real.principal.session.securityVersion };
  const realSession=await realSessions.issue(realIdentity,{ correlationId: randomUUID() });
  const sibling=await realSessions.issue(realIdentity,{ correlationId: randomUUID() });
  const tenants=createPostgresTenantRepository(pool);
  const customerServer=http.createServer(createProtectedHttpExecutionHandler({ config: customerConfig,surface: 'customer',
    executionScopes: owner.scopes,app: createApp({ config: customerConfig,
      sessionService: customerSessions,loadTenant: id=>tenants.findById(id),logger: createLogger({ write: line=>logs.push(line) }),
      additionalRouteModules: customer.routeModules }) }));
  const auditService=createPlatformAuditService({ repository: owner.auditRepository,authorizationPolicy,
    tenantTargetPolicy: createPlatformTenantTargetPolicy({
      operatorRepository: createPostgresPlatformOperatorRepository(pool,{ auditRepository: owner.auditRepository }) }) });
  const config={ mode: 'test',serviceVersion: '0.1.0',buildId: 'synthetic-http-native',publicOrigin: scope.platformOrigin,
    entraAuthority: `https://login.microsoftonline.com/${randomUUID()}`,entraClientId: randomUUID(),
    entraRedirectUri: `${scope.platformOrigin}/api/v1/platform/auth/microsoft/callback`,mfaAuthenticationContext: 'c1',
    stepUpAuthenticationContext: 'c2',authenticationMaxAgeSeconds: 900,maxBodyBytes: 32768,maxResponseBytes: 65536,
    rateLimitMax: 120,rateLimitWindowMs: 60000,rateLimitMaxKeys: 100,requestTimeoutMs: 5000,headersTimeoutMs: 5000,
    keepAliveTimeoutMs: 1000 };
  const platformServer=createPlatformHttpServer({ config,platformSessionService: owner.sessions,platformAuditService: auditService,
    logger: createPlatformLogger({ write: line=>logs.push(line) }),
    routeModules: [createPlatformSyntheticHandoffRouteModule({ protocol,intentCookie: cookieCodec,scope })] });
  for (const server of [customerServer,platformServer]) {
    servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  }
  async function request(surface,path,{ method='GET',body,form,headers={} }={}) {
    const server=surface==='customer' ? customerServer : platformServer;
    const origin=surface==='customer' ? scope.customerOrigin : scope.platformOrigin;
    const raw=form===undefined ? (body===undefined ? null : JSON.stringify(body)) : new URLSearchParams(form).toString();
    const contentType=form===undefined ? 'application/json' : 'application/x-www-form-urlencoded';
    return new Promise((resolve,reject)=>{
      const outgoing=http.request({ hostname: '127.0.0.1',port: server.address().port,path,method,
        headers: { host: new URL(origin).host,...(method==='POST' ? { origin,'sec-fetch-site': 'same-origin' } : {}),
          ...(raw===null ? {} : { 'content-type': contentType,'content-length': Buffer.byteLength(raw) }),...headers } },incoming=>{
        const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>resolve({ status: incoming.statusCode,
          headers: incoming.headers,text: Buffer.concat(chunks).toString('utf8') }));
      });outgoing.on('error',reject);outgoing.end(raw);
    });
  }
  // Actual email HTTP proof/admission uses the same owned normal resolver as the
  // later signed delegation. No test-only generic issuer enters the HTTP port.
  // The setup fixture has already consumed its own mailbox's request cooldown.
  // Create a fresh recipient through the actual authorized invitation endpoint;
  // neither stored budgets nor database time are changed for this new proof.
  const invitation=await request('customer','/api/v1/tenant/invitations',{ method: 'POST',
    body: { commandId: randomUUID(),invitations: [{ recipient: 'Assembly@example.test',roles: ['tenant_admin'],locale: 'de' }] },
    headers: { cookie: pair(realSession.setCookie),'x-csrf-token': realSession.csrfToken } });assert.equal(invitation.status,201);
  const email=await request('customer','/api/v1/auth/email/challenges',{ method: 'POST',
    body: { recipient: 'Assembly@example.test',locale: 'de' } });assert.equal(email.status,202);
  const emailCookie=pair(email.headers['set-cookie'][0]);
  const delivery=(await pool.query(`SELECT * FROM customer_access_deliveries WHERE purpose='mailbox_code'
    ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0];
  const bytes=cipher.open(delivery.payload_envelope,{ environment: 'int',mailboxId: delivery.mailbox_id,
    recordId: delivery.id,purpose: 'mailbox_code',tenantId: null });
  let code;try { code=JSON.parse(bytes.toString('utf8')).text.match(/\b\d{8}\b/)[0]; } finally { bytes.fill(0); }
  const verified=await request('customer','/api/v1/auth/email/verify',{ method: 'POST',body: { code },
    headers: { cookie: emailCookie,'x-csrf-token': JSON.parse(email.text).csrfToken } });assert.equal(verified.status,200);
  const choiceCookie=pair(verified.headers['set-cookie'][0]);
  const choices=await request('customer','/api/v1/auth/email/choices',{ headers: { cookie: choiceCookie } });
  assert.equal(choices.status,200);assert.equal(JSON.parse(choices.text).items.length,1);
  const admitted=await request('customer','/api/v1/auth/email/selection',{ method: 'POST',
    body: { membershipId: JSON.parse(choices.text).items[0].membershipId },
    headers: { cookie: choiceCookie,'x-csrf-token': JSON.parse(verified.text).csrfToken } });assert.equal(admitted.status,204);
  const admittedCookie=pair(admitted.headers['set-cookie'][0]);
  const invitedPrincipal=await customerSessions.resolvePrincipal({ headers: { cookie: admittedCookie } });
  assert.equal(invitedPrincipal.providerIdentity.provider,'email_code');assert.equal(invitedPrincipal.tenantId,real.tenantId);
  assert.equal((await request('customer','/api/v1/session',{ headers: { cookie: admittedCookie } })).status,200);
  assert.equal((await request('customer','/api/v1/tenant/invitations',{ headers: { cookie: admittedCookie } })).status,200);
  assert.equal((await request('customer','/api/v1/session',{ headers: { cookie: real.cookie } })).status,401);
  assert.equal((await request('customer','/api/v1/auth/microsoft/login')).status,503);
  const count=async()=>(await pool.query('SELECT count(*)::int AS count FROM sessions')).rows[0].count,before=await count();
  const started=await request('customer','/api/v1/auth/delegation/start',{ method: 'POST',form: {} });assert.equal(started.status,303);
  const target=new URL(started.headers.location),original=pair(started.headers['set-cookie'][0]);
  const arrived=await request('platform',target.pathname+target.search,{ headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(arrived.status,303);assert.equal(await count(),before);
  const opsCookie=`${pair(owner.current().setCookie)}; ${pair(arrived.headers['set-cookie'][0])}`;
  const selection={ generationId: generation.generationId,slot: 'northwind',role: 'employee' };
  const options=await request('platform','/api/v1/platform/auth/delegation/options',{ method: 'POST',body: selection,
    headers: { cookie: opsCookie,'x-csrf-token': owner.current().csrfToken } });assert.equal(options.status,200);
  const challenge=JSON.parse(options.text);
  const approved=await request('platform','/api/v1/platform/auth/delegation/approve',{ method: 'POST',
    form: { csrfToken: owner.current().csrfToken,payload: JSON.stringify({ ...selection,state: challenge.state,
      response: owner.keys[0].response('get',{ counter: 2,client: { challenge: challenge.options.challenge } }) }) },
    headers: { cookie: `${opsCookie}; ${pair(options.headers['set-cookie'][0])}` } });
  assert.equal(approved.status,303);assert.equal(await count(),before);
  const future=await owner.sessions.resolvePrincipal({ headers: { cookie: pair(approved.headers['set-cookie'][0]) } });
  assert.ok(future);assert.equal(future.assurance.level,'mfa');assert.notEqual(future.session.id,owner.current().principal.session.id);
  const callbackUrl=new URL(approved.headers.location);assert.equal(callbackUrl.origin,scope.customerOrigin);
  const callback=await request('customer',callbackUrl.pathname+callbackUrl.search,
    { headers: { cookie: original,'sec-fetch-site': 'cross-site' } });
  assert.equal(callback.status,303);assert.equal(callback.headers.location,'/?auth=synthetic_confirmation');
  assert.equal(await count(),before);
  const completionCookie=`${original}; ${pair(callback.headers['set-cookie'][0])}`;
  const confirmation=await request('customer','/api/v1/auth/delegation/confirmation',{ headers: { cookie: completionCookie } });
  assert.equal(confirmation.status,200);const csrfToken=JSON.parse(confirmation.text).csrfToken;
  const realCookie=pair(realSession.setCookie),switchCookie=`${completionCookie}; ${realCookie}`;
  const switchView=await request('customer','/api/v1/auth/delegation/confirmation',{ headers: { cookie: switchCookie } });
  assert.equal(JSON.parse(switchView.text).accountSwitchRequired,true);
  const blocked=await request('customer','/api/v1/auth/delegation/complete',{ method: 'POST',form: { csrfToken },
    headers: { cookie: switchCookie } });assert.equal(blocked.status,409);assert.equal(blocked.headers['set-cookie'],undefined);
  const wrong=await request('customer','/api/v1/auth/delegation/logout',{ method: 'POST',body: {},
    headers: { cookie: switchCookie,'x-csrf-token': '0'.repeat(64) } });assert.equal(wrong.status,401);
  assert.ok(await realSessions.resolvePrincipal({ headers: { cookie: realCookie } }));
  const logout=await request('customer','/api/v1/auth/delegation/logout',{ method: 'POST',body: {},
    headers: { cookie: switchCookie,'x-csrf-token': csrfToken } });assert.equal(logout.status,204);
  assert.match(logout.headers['set-cookie'][0],/^cm_session=;.*Max-Age=0/);
  assert.equal(await realSessions.resolvePrincipal({ headers: { cookie: realCookie } }),null);
  assert.ok(await realSessions.resolvePrincipal({ headers: { cookie: pair(sibling.setCookie) } }));
  assert.equal(await tenantAudit.verifyTenantChain(real.tenantId),true);assert.equal(await count(),before);
  const unknown=await request('customer','/api/v1/auth/delegation/logout',{ method: 'POST',body: {},
    headers: { cookie: `${completionCookie}; cm_session=invalid`,'x-csrf-token': csrfToken } });
  assert.equal(unknown.status,204);assert.match(unknown.headers['set-cookie'][0],/^cm_session=;.*Max-Age=0/);
  const complete=()=>request('customer','/api/v1/auth/delegation/complete',{ method: 'POST',form: { csrfToken },
    headers: { cookie: completionCookie } });
  const results=await Promise.all([complete(),complete()]);assert.deepEqual(results.map(result=>result.status).sort(),[303,401]);
  assert.equal(await count(),before+1);const customerCookie=pair(results.find(result=>result.status===303).headers['set-cookie'][0]);
  assert.ok(await customerSessions.resolvePrincipal({ headers: { cookie: customerCookie } }));
  assert.equal((await request('customer','/api/v1/session',{ headers: { cookie: customerCookie } })).status,200);
  assert.equal(await tenantAudit.verifyTenantChain(generation.tenants[0].tenantId),true);
  await owner.sessions.revoke(future,{ correlationId: randomUUID() });
  assert.equal((await request('customer','/api/v1/session',{ headers: { cookie: customerCookie } })).status,401);
  const handoffId=target.searchParams.get('flow');
  const retained=(await pool.query(`SELECT status,customer_session_id,source_platform_session_id,approval_proof_id
    FROM synthetic_customer_handoffs WHERE id=$1`,[handoffId])).rows[0];
  assert.equal((await pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[retained.customer_session_id])).rows[0].revoked_at,null);
  // Actual10s generation cooldown, followed by a new independent challenge and
  // signed assertion. No timestamps, retained proof rows or cap5 are weakened.
  await new Promise(resolve=>setTimeout(resolve,10_100));await owner.freshSession();
  const resetIntent={ operatorId: owner.operatorId,expectedGenerationId: generation.generationId,expectedRevision: generation.revision };
  const resetHash=generationService.operationHash(resetIntent),fresh=owner.current();
  const resetProof=await owner.scopes.withShared(()=>owner.auth.startStepUp(fresh.principal,{ operationHash: resetHash }));
  const reset=await owner.auth.executeStepUp({ operationHash: resetHash,state: resetProof.state,
    cookie: readPlatformPasskeyTransactionCookie({ cookie: pair(resetProof.setCookie) }),
    response: owner.keys[0].response('get',{ counter: 3,client: { challenge: resetProof.options.challenge } }),
    request: { headers: { cookie: pair(fresh.setCookie) } } },
  proofContext=>generationService.replace({ proofContext,intent: resetIntent,correlationId: randomUUID() }));
  assert.notEqual(reset.result.generationId,generation.generationId);
  assert.ok((await pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[retained.customer_session_id])).rows[0].revoked_at);
  assert.deepEqual((await pool.query(`SELECT status,customer_session_id,source_platform_session_id,approval_proof_id
    FROM synthetic_customer_handoffs WHERE id=$1`,[handoffId])).rows[0],retained);
  const history=(await pool.query(`SELECT tenant.status,
    (SELECT count(*)::int FROM requests WHERE tenant_id=tenant.id) AS requests,
    (SELECT count(*)::int FROM rooms WHERE tenant_id=tenant.id) AS rooms FROM tenants tenant WHERE id=$1`,
  [generation.tenants[0].tenantId])).rows[0];
  assert.deepEqual(history,{ status: 'archived',requests: 20,rooms: 10 });
  assert.ok(await customerSessions.resolvePrincipal({ headers: { cookie: admittedCookie } }));
  const sensitive=[callbackUrl.searchParams.get('code'),target.searchParams.get('state'),csrfToken,code,
    emailCookie.split('=')[1],admittedCookie.split('=')[1],original.split('=')[1],customerCookie.split('=')[1],future.session.id];
  for (const value of sensitive) assert.equal(logs.join('').includes(value),false,'private protocol/session value is never logged');
});
