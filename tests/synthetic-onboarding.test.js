import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { normalizeSyntheticOnboardingCommand,syntheticOnboardingCandidates,SyntheticOnboardingError }
  from '../src/domain/synthetic-onboarding.js';
import { createSyntheticOnboardingService } from '../src/application/synthetic-onboarding-service.js';
import { createSyntheticOnboardingRouteModule } from '../src/http/synthetic-onboarding-routes.js';
import { createProtectedTenantRuntimeViewRouteModule } from '../src/http/protected-tenant-runtime-view-routes.js';
import { createPostgresSyntheticOnboardingRepository } from '../src/persistence/postgres/synthetic-onboarding-repository.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const tenantId=randomUUID(),userId=randomUUID(),scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
  customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
const command={ expectedRevision: 2,selectedKeys: ['workshop','focus'] };
function context(role='tenant_admin') {
  return { principal: { tenantId,userId,...tenantAuthorizationSnapshot(['employee',role]),
    providerIdentity: { provider: 'test_identity',reference: userId },session: { id: randomUUID(),securityVersion: 1,
      issuedAt: '2026-10-21T10:00:00.000Z',expiresAt: '2026-10-21T18:00:00.000Z' } },
  tenantContext: { tenantId,status: 'onboarding' },correlationId: randomUUID() };
}

test('onboarding commands capture closed own values, bounded server candidate keys and exact legal lifecycle',()=>{
  const value=normalizeSyntheticOnboardingCommand(command,'import');assert.deepEqual(value.selectedKeys,['focus','workshop']);
  assert.ok(Object.isFrozen(value.selectedKeys));assert.deepEqual(command.selectedKeys,['workshop','focus']);
  const hostile=[];Object.defineProperty(hostile,0,{ get() { assert.fail('array getter must not execute'); } });
  for (const input of [{ ...command,mode: 'real' },{ ...command,tenantId: randomUUID() },{ ...command,expectedRevision: 0 },
    { ...command,selectedKeys: [] },{ ...command,selectedKeys: ['workshop','workshop'] },{ ...command,selectedKeys: ['foreign'] },
    { ...command,selectedKeys: hostile }]) assert.throws(()=>normalizeSyntheticOnboardingCommand(input,'import'),SyntheticOnboardingError);
  const accessor={ ...command };Object.defineProperty(accessor,'expectedRevision',{ get() { assert.fail('getter must not execute'); } });
  assert.throws(()=>normalizeSyntheticOnboardingCommand(accessor,'import'),SyntheticOnboardingError);
  assert.deepEqual(normalizeSyntheticOnboardingCommand({ expectedRevision: 3,expectedStatus: 'ready',targetStatus: 'active' },'lifecycle'),
    { expectedRevision: 3,expectedStatus: 'ready',targetStatus: 'active' });
  assert.throws(()=>normalizeSyntheticOnboardingCommand({ expectedRevision: 3,expectedStatus: 'onboarding',targetStatus: 'active' },
    'lifecycle'),SyntheticOnboardingError);
});

test('discovery is current synthetic-slot data with no REAL, Microsoft identity or arbitrary provider candidate',()=>{
  const runtime={ mode: 'synthetic',tenantId,generationId: randomUUID(),slot: 'fabrikam' };
  assert.deepEqual(syntheticOnboardingCandidates(runtime).map(row=>row.key),['workshop','focus']);
  assert.deepEqual(syntheticOnboardingCandidates({ ...runtime,slot: 'northwind' }),[]);
  assert.throws(()=>syntheticOnboardingCandidates({ ...runtime,mode: 'real' }),SyntheticOnboardingError);
});

test('application uses actual Tenant Admin authority, exact normalized commands and canonical atomic audit ports',async()=>{
  const calls=[],audit=createAuditHarness(),repository={
    async view(input) { calls.push(input);return { marker: 'current' }; },
    async importRooms(input) { calls.push(input);return input.auditEventFor({ importedCount: 2,revision: 3 }); },
    async transition(input) { calls.push(input);return input.auditEvent; },
  };
  const service=createSyntheticOnboardingService({ repository,authorizationPolicy: createAuthorizationPolicy(),
    auditService: audit.service });
  const admin=context();assert.deepEqual(await service.view(admin),{ marker: 'current' });
  const imported=await service.importRooms(admin,command);assert.equal(imported.tenantId,tenantId);
  assert.equal(imported.actorUserId,userId);assert.equal(imported.action,'tenant.configuration.changed');
  assert.deepEqual(imported.newState,{ importedCount: 2,locationsRevision: 3 });
  assert.equal(calls.at(-1).principal,admin.principal);
  const lifecycle=await service.transition(admin,{ expectedRevision: 3,expectedStatus: 'onboarding',targetStatus: 'ready' });
  assert.equal(lifecycle.action,'tenant.lifecycle.changed');assert.deepEqual(lifecycle.previousState,{ status: 'onboarding' });
  const before=calls.length;await assert.rejects(service.view(context('conference_manager')));
  await assert.rejects(service.importRooms({ ...admin,tenantContext: { tenantId: randomUUID(),status: 'onboarding' } },command));
  await assert.rejects(service.transition(admin,{ expectedRevision: 3,expectedStatus: 'active',targetStatus: 'suspended' }));
  assert.equal(calls.length,before);
});

test('the private onboarding repository requires the live exact shared scope before any SQL and cannot compose PROD',async()=>{
  const pool={ query() { assert.fail('no unscope SQL'); },connect() { assert.fail('no unscope connection'); } };
  const options={ scope,auditRepository: { appendWithClient() {} } },repository=createPostgresSyntheticOnboardingRepository(pool,options);
  await assert.rejects(repository.view({ principal: context().principal }),/PROTECTED_SHARED_EXECUTION_REQUIRED/);
  await assert.rejects(repository.importRooms({ principal: context().principal,...command,auditEventFor() {} }),
    /PROTECTED_SHARED_EXECUTION_REQUIRED/);
  assert.throws(()=>createPostgresSyntheticOnboardingRepository(pool,{ ...options,scope: { ...scope,environment: 'prod' } }));
});

async function httpFixture() {
  const calls=[],service={ view: async context=>{ calls.push(['view',context]);return { mode: 'synthetic' }; },
    importRooms: async (context,body)=>{ calls.push(['import',context,body]);return { importedCount: 2 }; },
    transition: async ()=>{ throw new SyntheticOnboardingError('SYNTHETIC_ONBOARDING_CONFLICT'); } };
  const module=createSyntheticOnboardingRouteModule({ service,publicOrigin: scope.customerOrigin });
  const handler=module.createHandler({ principalGuard: { async require(request,options) {
    calls.push(['guard',options]);return context().principal; } },
    tenantGuard: { async requireKnown() { return { tenantId,status: 'onboarding' }; } },maxBodyBytes: 8192,maxResponseBytes: 8192 });
  async function call(path,{ method='GET',body,headers={} }={}) {
    const request=Readable.from(body===undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method=method;request.headers={ origin: scope.customerOrigin,'sec-fetch-site': 'same-origin',
      ...(body===undefined ? {} : { 'content-type': 'application/json','content-length': String(Buffer.byteLength(JSON.stringify(body))) }),
      ...headers };
    const response={ headers: {},setHeader(key,value) { this.headers[key]=value; },end(value) { this.body=value; } };
    const status=await handler({ request,response,path,parsedUrl: new URL(path,scope.customerOrigin),requestId: randomUUID() });
    return { status,response };
  }
  return { call,calls,module };
}

test('onboarding HTTP keeps exact paths, read-only GET, same-origin CSRF mutations and bounded conflict mapping',async()=>{
  const f=await httpFixture(),root='/api/v1/integrations/synthetic-calendar';
  assert.equal((await f.call(root)).status,200);assert.deepEqual(f.calls[0],['guard',{ csrf: false }]);
  assert.equal((await f.call(root+'/rooms/import',{ method: 'POST',body: command })).status,200);
  assert.deepEqual(f.calls.find(call=>call[0]==='guard' && call[1].csrf),['guard',{ csrf: true }]);
  await assert.rejects(f.call(root+'/lifecycle/transitions',{ method: 'POST',body: {} }),{ statusCode: 409 });
  const before=f.calls.length;
  await assert.rejects(f.call(root+'/rooms/import',{ method: 'POST',body: command,headers: { origin: 'https://foreign.example' } }),
    { statusCode: 403 });
  await assert.rejects(f.call(root,{ body: {} }),{ statusCode: 400 });
  assert.equal(f.calls.length,before+1,'a GET body may resolve its current principal but cannot call the service');
  assert.equal(f.module.routeKey(root+'/rooms/import/extra'),null);
});


test('presentation runtime mode is read-only current server classification with no caller mode or provider',async()=>{
  let wrong=false,calls=0;
  const module=createProtectedTenantRuntimeViewRouteModule({ environment: scope.environment,securityEpoch: scope.securityEpoch,
    runtimeRepository: { async withCurrentTenantRuntime(input,work) {
      calls++;assert.deepEqual(input,{ environment: scope.environment,securityEpoch: scope.securityEpoch,tenantId });
      return work({ ...input,tenantId: wrong ? randomUUID() : tenantId,mode: 'real',
        generationId: null,generationState: null,operatorId: null,slot: null });
    } } });
  const handler=module.createHandler({ principalGuard: { async require() { return context().principal; } },
    tenantGuard: { async requireKnown() { return { tenantId,status: 'onboarding' }; } },maxResponseBytes: 4096 });
  async function read(query='') {
    const request=Readable.from([]);request.method='GET';request.headers={};
    const response={ setHeader() {},end(value) { this.body=value; } };
    await handler({ request,response,path: '/api/v1/tenant/runtime',parsedUrl: new URL('/api/v1/tenant/runtime'+query,
      scope.customerOrigin),requestId: randomUUID() });return JSON.parse(response.body);
  }
  const value=await read();assert.equal(value.mode,'real');assert.equal(value.provider,'microsoft365');
  await assert.rejects(read('?mode=synthetic'),{ statusCode: 400 });assert.equal(calls,1);
  wrong=true;await assert.rejects(read());
});
