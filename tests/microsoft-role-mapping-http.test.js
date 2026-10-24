import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createHttpServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createTenantMicrosoftRoleService } from '../src/application/tenant-microsoft-role-service.js';
import { createMicrosoftRoleMappingRouteModule } from '../src/http/settings/microsoft-role-mapping-routes.js';
import { createAuditHarness } from './support/audit-harness.js';

const ORIGIN='https://127.0.0.1',PATH='/api/v1/tenant/microsoft-role-mappings',CSRF='c'.repeat(43);
const id=n=>`e8000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const command={ directoryId: id(4),mappings: [{ groupId: id(5),roles: ['conference_manager'] }],expectedRevision: 0 };
async function fixture(t,{ authenticated=true,roles=['employee','tenant_admin'],conflict=false }={}) {
  const calls=[],logs=[],audit=createAuditHarness();
  const principal={ tenantId: id(1),userId: id(2),providerIdentity: { provider: 'test_identity',reference: id(2) },
    ...tenantAuthorizationSnapshot(roles),session: { id: id(3),securityVersion: 1,
      issuedAt: new Date(Date.now()-1000).toISOString(),expiresAt: new Date(Date.now()+3600000).toISOString() } };
  const service=createTenantMicrosoftRoleService({ authorizationPolicy: createAuthorizationPolicy(),auditService: audit.service,
    repository: { async get(input) { calls.push(input);return { revision: 0,directoryId: null,mappings: [] }; },
      async replace(input) { calls.push(input);return conflict ? { status: 'version_conflict',currentRevision: 2 }
        : { status: 'updated',settings: { revision: 1,directoryId: input.directoryId,mappings: input.mappings } }; } } });
  const server=createHttpServer({ config: loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: ORIGIN,RATE_LIMIT_MAX: '120' }),
    logger: createLogger({ write: line=>logs.push(line) }),resolvePrincipal: async()=>authenticated ? principal : null,
    verifyCsrf: async request=>request.headers['x-csrf-token']===CSRF,
    loadTenant: async tenantId=>({ id: tenantId,displayName: 'Synthetic Tenant',status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',updatedAt: '2026-10-01T00:00:00.000Z' }),
    additionalRouteModules: [createMicrosoftRoleMappingRouteModule({ service,publicOrigin: ORIGIN })] });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=({ method='GET',body=null,headers={},suffix='' }={})=>new Promise((resolve,reject)=>{
    const bytes=body===null ? null : JSON.stringify(body),selected={ host: '127.0.0.1',origin: ORIGIN,
      'sec-fetch-site': 'same-origin','x-csrf-token': CSRF,...(bytes===null ? {} : {
        'content-type': 'application/json','content-length': Buffer.byteLength(bytes) }),...headers };
    const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path: PATH+suffix,method,
      headers: Object.fromEntries(Object.entries(selected).filter(([,value])=>value!==undefined)) },res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString();resolve({ status: res.statusCode,headers: res.headers,
          body: text ? JSON.parse(text) : null });
      });
    });req.on('error',reject);if (bytes!==null) req.write(bytes);req.end();
  });
  return { calls,logs,request };
}
test('mapping HTTP uses current Tenant Admin authority, exact write contract, no-store and optimistic revision',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request()).status,200);
  const answer=await f.request({ method: 'PUT',body: command,headers: { 'x-tenant-id': id(9),'x-user-id': id(8) } });
  assert.equal(answer.status,200);assert.equal(answer.body.settings.revision,1);
  assert.equal(answer.headers['cache-control'],'no-store');
  assert.equal(f.calls[1].tenantId,id(1));assert.equal(f.calls[1].actorUserId,id(2));
  assert.doesNotMatch(JSON.stringify(answer.body),/actorUserId|tenantId|audit_event/);
  const conflict=await fixture(t,{ conflict: true });
  assert.equal((await conflict.request({ method: 'PUT',body: command })).status,409);
});
test('anonymous, Employee, missing CSRF, foreign origins and injected authority cannot mutate mappings',async t=>{
  const anonymous=await fixture(t,{ authenticated: false });assert.equal((await anonymous.request()).status,401);
  const employee=await fixture(t,{ roles: ['employee'] });
  assert.equal((await employee.request()).status,403);
  assert.equal((await employee.request({ method: 'PUT',body: command })).status,403);
  const f=await fixture(t);
  for (const headers of [{ 'x-csrf-token': undefined },{ origin: 'https://foreign.example' },
    { origin: undefined },{ 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.request({ method: 'PUT',body: command,headers })).status,403);
  }
  for (const body of [{ ...command,tenantId: id(9) },{ ...command,roles: ['tenant_admin'] },
    { ...command,mappings: [{ groupId: id(5),roles: ['platform_security_admin'] }] },
    { ...command,expectedRevision: -1 }]) assert.equal((await f.request({ method: 'PUT',body })).status,400);
  assert.equal((await f.request({ suffix: '?tenantId='+id(9) })).status,400);
  assert.equal(f.calls.length,0);assert.equal(employee.calls.length,0);assert.equal(anonymous.calls.length,0);
});
