import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { CustomerInvitationConflictError } from '../src/domain/customer-invitation-errors.js';
import { createCustomerInvitationRouteModule } from '../src/http/customer-invitation-routes.js';
import { createHttpServer } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { createAuditHarness } from './support/audit-harness.js';

const ORIGIN='https://127.0.0.1',ROOT='/api/v1/tenant/invitations',CSRF='c'.repeat(43);
const id=n => `f5000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const intent=(recipient='Invited@example.com',roles=['tenant_admin']) => ({ recipient,roles,locale: 'de' });
const row=extra => ({ tenantId: id(1),environment: 'int',id: id(10),revision: 1,...intent(),state: 'pending',
  expiresAt: '2099-01-01T00:00:00.000Z',delivery: 'queued',...extra });

async function fixture(t,{ roles=['employee','tenant_admin'],authenticated=true,injected=true,override=null } = {}) {
  const calls=[],logs=[];const audit=createAuditHarness(),authorizationPolicy=createAuthorizationPolicy();
  const principal={ tenantId: id(1),userId: id(2),providerIdentity: { provider: 'test_identity',reference: id(2) },
    ...tenantAuthorizationSnapshot(roles),session: { id: id(3),securityVersion: 1,
      issuedAt: new Date(Date.now()-10000).toISOString(),expiresAt: new Date(Date.now()+3600000).toISOString() } };
  const repository={
    async list(input) { calls.push({ name: 'list',input });return [row()]; },
    async issueBatch(input) {
      calls.push({ name: 'issueBatch',input });return input.invitations.map((entry,index) => {
        input.auditEventFor({ invitationId: id(10+index),nextRevision: 1,occurredAt: new Date().toISOString() });
        return row({ ...entry,id: id(10+index) });
      });
    },
  };
  for (const name of ['reissue','revoke']) repository[name]=async input => {
    calls.push({ name,input });
    if (input.invitationId!==id(10)) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE',{ conceal: true });
    if (input.expectedRevision!==1) throw new CustomerInvitationConflictError();
    input.auditEventFor({ invitationId: id(10),nextRevision: 2,occurredAt: new Date().toISOString() });
    return row({ revision: 2,...(name==='revoke' ? { state: 'revoked',delivery: 'cancelled' } : {}) });
  };
  const service=override || createCustomerInvitationService({ repository,authorizationPolicy,
    auditService: audit.service,environment: 'int' });
  const module=createCustomerInvitationRouteModule({ service,publicOrigin: ORIGIN });
  const config={ ...loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: ORIGIN,RATE_LIMIT_MAX: '120' }) };
  const server=createHttpServer({ config,logger: createLogger({ write: line => logs.push(line) }),
    resolvePrincipal: async () => authenticated ? principal : null,
    verifyCsrf: async request => request.headers['x-csrf-token']===CSRF,
    loadTenant: async tenantId => ({ id: tenantId,displayName: 'Synthetic Tenant',status: 'onboarding',
      createdAt: '2026-10-01T00:00:00.000Z',updatedAt: '2026-10-01T00:00:00.000Z' }),
    additionalRouteModules: injected ? [module] : [] });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function request({ suffix='',method='GET',body=null,headers={} } = {}) {
    const bytes=body===null ? null : typeof body==='string' ? body : JSON.stringify(body);
    const selected={ host: '127.0.0.1',origin: ORIGIN,'sec-fetch-site': 'same-origin','x-csrf-token': CSRF,
      ...(bytes===null ? {} : { 'content-type': 'application/json','content-length': Buffer.byteLength(bytes) }),...headers };
    return new Promise((resolve,reject) => {
      const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path: `${ROOT}${suffix}`,method,
        headers: Object.fromEntries(Object.entries(selected).filter(([,value]) => value!==undefined)) },res => {
        const chunks=[];res.on('data',chunk => chunks.push(chunk));res.on('end',() => {
          const text=Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode,headers: res.headers,body: text ? JSON.parse(text) : null,text });
        });
      });
      req.on('error',reject);if (bytes!==null) req.write(bytes);req.end();
    });
  }
  return { calls,logs,audit,principal,request };
}

test('invitation HTTP derives current Tenant Admin authority and supports bounded list, batch, reissue and revocation',async t => {
  const f=await fixture(t);
  let answer=await f.request({ suffix: `?limit=20&afterId=${id(8).toUpperCase()}` });assert.equal(answer.status,200);
  assert.equal(f.calls[0].input.tenantId,id(1));assert.equal(f.calls[0].input.limit,20);
  assert.equal(f.calls[0].input.afterInvitationId,id(8));assert.equal(answer.headers['cache-control'],'no-store');
  answer=await f.request({ method: 'POST',body: { commandId: id(20),
    invitations: [intent(),intent('Employee@example.com',[])] },headers: { 'x-tenant-id': id(90),'x-user-id': id(91) } });
  assert.equal(answer.status,201);assert.equal(answer.body.invitations.length,2);
  assert.equal(f.calls[1].input.tenantId,id(1));assert.equal(f.calls[1].input.principal.userId,id(2));
  assert.equal(f.calls[1].input.environment,'int');assert.equal(f.calls[1].input.commandId,id(20));
  assert.doesNotMatch(answer.text,/tenantId|userId|environment|browserToken|provider|delivered/);
  answer=await f.request({ suffix: `/${id(10)}/reissue`,method: 'POST',body: { expectedRevision: 1 } });
  assert.equal(answer.status,200);assert.equal(answer.body.invitation.revision,2);assert.equal(answer.body.invitation.delivery,'queued');
  answer=await f.request({ suffix: `/${id(10)}/revoke`,method: 'POST',body: { expectedRevision: 1 } });
  assert.equal(answer.status,200);assert.equal(answer.body.invitation.state,'revoked');
  assert.equal(answer.body.invitation.delivery,'cancelled');
  assert.doesNotMatch(f.logs.join(''),/Invited@example|Employee@example|csrf|recipient|tenantId|userId/);
});

test('missing authentication/CSRF, non-Admin roles and foreign objects cannot write or expose invitation scope',async t => {
  const anonymous=await fixture(t,{ authenticated: false });
  assert.equal((await anonymous.request()).status,401);assert.equal(anonymous.calls.length,0);
  for (const roles of [['employee'],['employee','conference_manager']]) {
    const f=await fixture(t,{ roles });
    for (const input of [{},{ method: 'POST',body: { commandId: id(20),invitations: [intent()] } },
      { suffix: `/${id(10)}/revoke`,method: 'POST',body: { expectedRevision: 1 } }]) {
      assert.equal((await f.request(input)).status,403);
    }
    assert.equal(f.calls.length,0);
  }
  const f=await fixture(t);
  for (const headers of [{ 'x-csrf-token': undefined },{ 'x-csrf-token': 'wrong' },{ origin: undefined },
    { origin: 'https://foreign.example' },{ 'sec-fetch-site': 'cross-site' }]) {
    const answer=await f.request({ method: 'POST',body: { commandId: id(20),invitations: [intent()] },headers });
    assert.equal(answer.status,403);
  }
  assert.equal(f.calls.length,0);
  const foreign=await f.request({ suffix: `/${id(90)}/revoke`,method: 'POST',body: { expectedRevision: 1 } });
  assert.equal(foreign.status,404);assert.doesNotMatch(foreign.text,/Invited@example|tenantId|userId/);
  const stale=await f.request({ suffix: `/${id(10)}/reissue`,method: 'POST',body: { expectedRevision: 2 } });
  assert.equal(stale.status,409);assert.equal(stale.body.error.code,'CUSTOMER_INVITATION_CONFLICT');
});

test('invitation methods, body/query limits and nested authority overrides fail before persistence',async t => {
  const f=await fixture(t);
  for (const suffix of ['?limit=101','?limit=0','?limit=01','?limit=2&limit=3','?tenantId=foreign','?afterId=invalid']) {
    assert.equal((await f.request({ suffix })).status,400);
  }
  for (const body of [{ commandId: id(20),invitations: [] },{ commandId: id(20),invitations: Array(21).fill(intent()) },
    { commandId: id(20),invitations: [intent()],tenantId: id(90) },
    { commandId: id(20),invitations: [intent('Invited@example.com',['platform_admin'])] },
    { commandId: id(20),invitations: [{ ...intent(),userId: id(91) }] }]) {
    assert.equal((await f.request({ method: 'POST',body })).status,400);
  }
  for (const body of [{ expectedRevision: 0 },{ expectedRevision: Number.MAX_SAFE_INTEGER },
    { expectedRevision: 1,roles: ['conference_manager'] }]) {
    assert.equal((await f.request({ suffix: `/${id(10)}/reissue`,method: 'POST',body })).status,400);
  }
  assert.equal((await f.request({ method: 'POST',body: { commandId: id(20),invitations: [intent()] },
    headers: { 'content-type': 'text/plain' } })).status,415);
  assert.equal((await f.request({ method: 'POST',body: 'x'.repeat(16385) })).status,413);
  assert.equal((await f.request({ body: 'unexpected' })).status,400);
  assert.equal((await f.request({ method: 'DELETE' })).status,405);
  assert.equal((await f.request({ suffix: `/${id(10)}/revoke`,method: 'GET' })).status,405);
  assert.equal((await f.request({ suffix: '/invalid/revoke',method: 'POST',body: { expectedRevision: 1 } })).status,404);
  assert.equal(f.calls.length,0);
});

test('transport projects only the public receipt and default composition exposes no invitation route',async t => {
  const privateRow={ id: id(10),revision: 1,...intent(),state: 'pending',delivery: 'queued',expiresAt: '2099-01-01T00:00:00.000Z',
    tenantId: id(90),browserToken: 'private',providerPayload: { private: true } };
  const f=await fixture(t,{ override: { async list() { return [privateRow]; },
    async issueBatch() {},async reissue() {},async revoke() {} } });
  const answer=await f.request();assert.equal(answer.status,200);
  assert.doesNotMatch(answer.text,/tenantId|browserToken|providerPayload|private/);
  const absent=await fixture(t,{ injected: false });assert.equal((await absent.request()).status,404);assert.equal(absent.calls.length,0);
});
