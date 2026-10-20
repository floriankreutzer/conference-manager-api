import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig,loadDatabaseConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { createPostgresCustomerMicrosoftFlowRepository } from '../src/persistence/postgres/customer-microsoft-flow-repository.js';
import { createCustomerMicrosoftAuthenticationService } from '../src/identity/customer-microsoft-authentication-service.js';
import { createCustomerMicrosoftAdmissionService } from '../src/identity/customer-microsoft-admission-service.js';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
import { createCustomerEmailSourceKey } from '../src/identity/customer-email-source-key.js';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';
import { createCustomerMicrosoftAuthenticationRouteModule } from '../src/http/customer-microsoft-authentication-routes.js';
import { createTenantAuditQueryService } from '../src/audit/tenant-audit-query-service.js';
import { createPostgresTenantAuditQueryRepository } from '../src/persistence/postgres/tenant-audit-query-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
const ORIGIN='https://127.0.0.1',ROOT='/api/v1/auth/microsoft';
const CLIENT='bb000000-0000-4000-8000-000000000001',DIRECTORY='bb000000-0000-4000-8000-000000000002';
const SUBJECT='bb000000-0000-4000-8000-000000000003',AUTHORITY='https://login.microsoftonline.com/organizations';

test('real loopback HTTP, sessions, encrypted email admission and PostgreSQL compose explicit Microsoft login/link/audit custody',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  const customer=await createInvitedCustomerFixture(pool,t);
  const binding=createCustomerMicrosoftFlowBinding({ secret: 'm'.repeat(48),environment: 'int' });t.after(()=>binding.destroy());
  const sourceKey=createCustomerEmailSourceKey({ secret: 's'.repeat(48),environment: 'int' });t.after(()=>sourceKey.destroy());
  const repository=createPostgresCustomerMicrosoftFlowRepository(pool,{ environment: 'int',flowBinding: binding,
    auditRepository: customer.auditRepository });
  const provider=microsoftCodeSdkFixture({ clientId: CLIENT,authority: AUTHORITY,tenantId: DIRECTORY,userId: SUBJECT,clock: Date.now });
  const authenticationService=createCustomerMicrosoftAuthenticationService({ repository,flowBinding: binding,
    entraClient: createFreshCustomerEntraClient({ clientId: CLIENT,clientSecret: 'c'.repeat(48),authority: AUTHORITY,
      publicOrigin: ORIGIN,applicationFactory: ()=>provider.application() }) });
  const admissionService=createCustomerMicrosoftAdmissionService({ repository,auditService: customer.auditService,
    sessionService: customer.sessions });
  const tenantAuditQueryService=createTenantAuditQueryService({
    queryRepository: createPostgresTenantAuditQueryRepository(pool),integrityRepository: customer.auditRepository,
    authorizationPolicy: customer.authorizationPolicy,auditService: customer.auditService });
  const server=createHttpServer({ config: loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: ORIGIN,RATE_LIMIT_MAX: '120' }),
    sessionService: customer.sessions,auditService: customer.auditService,authorizationPolicy: customer.authorizationPolicy,
    loadTenant: createPostgresTenantRepository(pool,{ auditRepository: customer.auditRepository }).findById,
    tenantAuditQueryService,logger: createLogger({ write() {} }),customerMicrosoftAuthenticationRouteModule:
      createCustomerMicrosoftAuthenticationRouteModule({ authenticationService,admissionService,sourceKey,
        sessionService: customer.sessions,publicOrigin: ORIGIN }) });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const jar=new Map([customer.cookie.split('=')]);
  const originalEmailCookie=customer.cookie;
  async function request(method,path,{ body,csrf }={}) {
    const text=body===undefined ? null : JSON.stringify(body);
    return new Promise((resolve,reject)=>{
      const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path,method,agent: false,
        headers: { Host: '127.0.0.1',Origin: ORIGIN,'Sec-Fetch-Site': 'same-origin',
          Cookie: [...jar].map(([name,value])=>`${name}=${value}`).join('; '),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(text===null ? {} : { 'Content-Type': 'application/json','Content-Length': Buffer.byteLength(text) }) } },res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
          for (const cookie of res.headers['set-cookie'] ?? []) {
            const pair=cookie.split(';')[0],index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);
            if (/; Max-Age=0(?:;|$)/.test(cookie)) jar.delete(name);else jar.set(name,value);
          }
          const raw=Buffer.concat(chunks).toString('utf8');resolve({ status: res.statusCode,headers: res.headers,
            value: raw ? JSON.parse(raw) : null });
        });
      });req.on('error',reject);req.end(text);
    });
  }
  async function callback(url) {
    const authorization=new URL(url);provider.state.sentNonce=authorization.searchParams.get('nonce');
    const parameters=new URLSearchParams({ state: authorization.searchParams.get('state'),code: 'synthetic-code' });
    return request('GET',`${ROOT}/callback?${parameters}`);
  }
  const session=await request('GET','/api/v1/session');assert.equal(session.status,200);
  assert.equal((await request('GET',`${ROOT}/link/status`)).value.microsoftLinked,false);
  assert.equal((await request('POST',`${ROOT}/link/start`,{ body: {} })).status,403);
  const start=await request('POST',`${ROOT}/link/start`,{ body: {},csrf: session.value.csrfToken });assert.equal(start.status,200);
  assert.equal(provider.state.tokenRequests,0);
  const verified=await callback(start.value.authorizationUrl);assert.equal(verified.status,303);
  assert.equal(verified.headers.location,'/?auth=microsoft_link_confirmation_required');
  assert.equal((await request('GET',`${ROOT}/link/status`)).value.microsoftLinked,false);
  const confirmation=await request('GET',`${ROOT}/link/confirmation`);assert.equal(confirmation.status,200);
  assert.equal((await request('POST',`${ROOT}/link/confirm`,{ body: { confirm: true },csrf: session.value.csrfToken })).status,403);
  const linked=await request('POST',`${ROOT}/link/confirm`,{ body: { confirm: true },csrf: confirmation.value.csrfToken });
  assert.equal(linked.status,204);assert.equal(jar.has('cm_customer_microsoft_tx'),false);
  assert.equal(await customer.sessions.resolvePrincipal({ headers: { cookie: originalEmailCookie } }),null);
  const account=await request('GET',`${ROOT}/link/status`);assert.equal(account.status,200);
  assert.equal(account.value.microsoftLinked,true);
  assert.equal(account.value.emailReauthenticationRequired,true);
  assert.equal((await request('GET','/api/v1/session')).value.user.id,customer.principal.userId);
  // A fresh, independent browser login proves actual HTTP choice/session wiring.
  // The SDK/provider transport is synthetic in memory, never an external call.
  jar.clear();const login=await request('GET',`${ROOT}/login`);assert.equal(login.status,302);
  const returned=await callback(login.headers.location);assert.equal(returned.status,303);
  assert.equal(returned.headers.location,'/?auth=microsoft_membership_required');
  const choices=await request('GET',`${ROOT}/choices`);assert.equal(choices.status,200);
  assert.equal(choices.value.items.length,1);assert.equal(choices.value.items[0].membershipId,customer.membershipId);
  assert.equal((await request('POST',`${ROOT}/selection`,{ body: { membershipId: randomUUID() },
    csrf: choices.value.csrfToken })).status,401);
  const accepted=await request('POST',`${ROOT}/selection`,{ body: { membershipId: customer.membershipId },csrf: choices.value.csrfToken });
  assert.equal(accepted.status,204);const ordinary=await request('GET','/api/v1/session');assert.equal(ordinary.status,200);
  assert.equal(ordinary.value.user.id,customer.principal.userId);assert.equal(ordinary.value.tenant.id,customer.tenantId);
  assert.deepEqual(ordinary.value.roles,['employee','tenant_admin']);assert.equal(provider.state.tokenRequests,2);
  const history=await request('GET','/api/v1/audit?category=user&limit=100');assert.equal(history.status,200);
  const event=history.value.events.find(value=>value.action==='tenant.user.identity_linked');assert.ok(event);
  assert.doesNotMatch(JSON.stringify(event),/securityVersion|providerUserReference|providerTenantReference|synthetic-code/);
  assert.equal(await customer.auditRepository.verifyTenantChain(customer.tenantId),true);
});
