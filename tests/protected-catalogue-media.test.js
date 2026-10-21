import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPostgresProtectedCatalogueMediaRepository } from '../src/persistence/postgres/protected-catalogue-media-repository.js';
import { createProtectedCatalogueMediaService } from '../src/application/protected-catalogue-media-service.js';
import { createProtectedCatalogueMediaRouteModule } from '../src/http/protected-catalogue-media-routes.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { syntheticHandoffOperationHash,syntheticDelegationIdentityReference } from '../src/domain/synthetic-handoff.js';

const scope={ environment: 'int',securityEpoch: randomUUID() },full={ ...scope,platformSecurityEpoch: 7,
  customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
const tenantId=randomUUID(),userId=randomUUID(),generationId=randomUUID(),operatorId=randomUUID(),flowId=randomUUID();
const selection={ flowId,operatorId,generationId,slot: 'northwind',role: 'employee' };
const binding={ flowId,stateHash: 'a'.repeat(64),browserVerifier: 'b'.repeat(64) };
const principal={ tenantId,userId,...tenantAuthorizationSnapshot(['employee']),
  providerIdentity: { provider: 'platform_delegation',
    reference: syntheticDelegationIdentityReference({ generationId,operatorId,role: 'employee' }) },
  session: { id: randomUUID(),issuedAt: '2026-10-21T10:00:00.000Z',expiresAt: '2026-10-21T18:00:00.000Z',securityVersion: 3 } };
function fixture({ synthetic=true,enabled=true }={}) {
  const bytes=Buffer.alloc(40,5),asset={ id: randomUUID(),owner_kind: 'room_plan',owner_id: 'room-01',content_type: 'image/png',
    alt_text: '<img onerror=alert(1)>',bytes,object_key: null,byte_length: bytes.length,
    content_sha256: createHash('sha256').update(bytes).digest() };
  const calls=[],state={ mode: synthetic ? 'synthetic' : 'real',access: true,loseAccess: false,assets: [asset] };let held=false;
  const custody={ id: flowId,state_hash: binding.stateHash,browser_verifier: binding.browserVerifier,
    operator_id: operatorId,generation_id: generationId,tenant_id: tenantId,user_id: userId,slot: 'northwind',
    selected_role: 'employee',user_security_version: 3,current_roles: [],
    operation_hash: syntheticHandoffOperationHash(full,selection,binding) };
  const client={ async query(query) {
    calls.push(query);const name=query?.name;
    if (name==='protected-catalogue-media-current-tenant') return { rows: [{ mode: state.mode }],rowCount: 1 };
    if (name==='synthetic-customer-session-custody') return { rows: [{ id: flowId }],rowCount: state.access ? 1 : 0 };
    if (name==='synthetic-customer-current-custody') return { rows: [custody],rowCount: state.access ? 1 : 0 };
    if (name==='protected-customer-current-invited-access') return { rows: [{ roles: [] }],rowCount: state.access ? 1 : 0 };
    if (['protected-catalogue-media-list','protected-catalogue-media-bytes'].includes(name)) {
      if (state.loseAccess) state.access=false;return { rows: state.assets,rowCount: state.assets.length };
    }
    return { rows: [],rowCount: 0 };
  },release() { held=false; } };
  const pool={ query() { assert.fail('no unbound query'); },async connect() {
    assert.equal(held,false,'single business connection must be joined');held=true;return client;
  } };
  const leasePool={ query() {},async connect() { return { async query() {
    return { rowCount: 1,rows: [{ acquired: true }] };
  },release() {} }; } };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ ...scope,pool,leasePool });
  const repository=createPostgresProtectedCatalogueMediaRepository(pool,{ ...scope,syntheticScope: enabled ? full : null });
  const input={ tenantId,principal: synthetic ? principal : {
    ...principal,providerIdentity: { provider: 'email_code',reference: randomUUID() } } };
  return { repository,input,asset,state,calls,run: work=>scopes.withShared(work) };
}

test('catalogue reads requalify complete current synthetic custody inside one max1 transaction and expose bounded metadata',async()=>{
  const f=fixture(),list=await f.run(()=>f.repository.list(f.input));assert.equal(list.length,1);
  assert.deepEqual(Object.keys(list[0]).sort(),['altText','contentType','id','ownerId','ownerKind','url']);
  assert.equal(list[0].url,`/api/v1/tenant/catalogue-media/${f.asset.id}`);
  assert.equal(f.calls.filter(call=>call?.name==='synthetic-customer-current-custody').length,2);
  const asset=await f.run(()=>f.repository.find({ ...f.input,assetId: f.asset.id }));assert.deepEqual(asset.bytes,f.asset.bytes);
  asset.bytes[0]=99;assert.equal(f.asset.bytes[0],5,'returned bytes cannot mutate retained source bytes');
  const query=f.calls.find(call=>call?.name==='protected-catalogue-media-bytes');
  assert.deepEqual(query.values,[tenantId,f.asset.id,false]);assert.match(query.text,/floorplanAssetId/);
  assert.match(query.text,/room.active AND site.active/);assert.match(query.text,/package.active/);assert.match(query.text,/item.active/);
});

test('unknown mode, absent synthetic scope, revoked source, foreign principal and missing lease fail closed',async()=>{
  for (const options of [{ enabled: false },{}]) {
    const f=fixture(options);if (options.enabled!==false) f.state.access=false;
    await assert.rejects(f.run(()=>f.repository.list(f.input)));
    assert.equal(f.calls.some(call=>call?.name==='protected-catalogue-media-list'),false);
  }
  const f=fixture();await assert.rejects(f.repository.list(f.input),/PROTECTED_SHARED_EXECUTION_REQUIRED/);
  await assert.rejects(f.run(()=>f.repository.list({ ...f.input,tenantId: randomUUID() })));
  for (const mode of [null,'unknown']) { f.state.mode=mode;await assert.rejects(f.run(()=>f.repository.list(f.input))); }
  const revoked=fixture();revoked.state.loseAccess=true;await assert.rejects(revoked.run(()=>revoked.repository.list(revoked.input)));
  assert.throws(()=>createPostgresProtectedCatalogueMediaRepository({ query() {},connect() {} },{
    ...scope,environment: 'prod',syntheticScope: { ...full,environment: 'prod' } }));
});

test('positive REAL authority returns no synthetic assets without touching synthetic storage',async()=>{
  const f=fixture({ synthetic: false,enabled: false });assert.deepEqual(await f.run(()=>f.repository.list(f.input)),[]);
  assert.equal(await f.run(()=>f.repository.find({ ...f.input,assetId: randomUUID() })),null);
  assert.equal(f.calls.some(call=>String(call?.name).startsWith('synthetic-') || call?.name==='protected-catalogue-media-list'),false);
});

test('missing, oversized, corrupt and unprepared object assets cannot publish bytes',async()=>{
  const f=fixture();f.state.assets=[];assert.equal(await f.run(()=>f.repository.find({ ...f.input,assetId: randomUUID() })),null);
  for (const change of [{ object_key: 'private-object' },{ content_sha256: Buffer.alloc(32) },{ byte_length: 41 },
    { byte_length: 2097153 },{ content_type: 'image/svg+xml' },{ bytes: null }]) {
    const broken=fixture();Object.assign(broken.asset,change);
    await assert.rejects(broken.run(()=>broken.repository.find({ ...broken.input,assetId: broken.asset.id })));
  }
  const large=fixture();large.state.assets=Array(41).fill(large.asset);
  await assert.rejects(large.run(()=>large.repository.list(large.input)));
});

test('canonical service scopes inactive media to the existing catalogue Manager permission',async()=>{
  const calls=[],repository={ list: async input=>{ calls.push(input);return []; },find: async input=>{ calls.push(input);return null; } };
  const service=createProtectedCatalogueMediaService({ repository,authorizationPolicy: createAuthorizationPolicy() });
  const context={ principal,tenantContext: { tenantId,status: 'active' } };await service.list(context);
  assert.equal(calls[0].includeInactive,false);
  await service.find({ ...context,principal: {
    ...principal,...tenantAuthorizationSnapshot(['employee','conference_manager']) } },randomUUID());
  assert.equal(calls[1].includeInactive,true);assert.equal(calls[1].tenantId,tenantId);
  assert.throws(()=>service.list({ ...context,tenantContext: { tenantId: randomUUID(),status: 'active' } }));
});

test('HTTP authenticates every conditional image read, bounds transport and returns no private bytes on denied ownership',async()=>{
  let allowed=true,exists=true,reads=0;
  const assetId=randomUUID(),root='/api/v1/tenant/catalogue-media',module=createProtectedCatalogueMediaRouteModule({ service: {
    async list() { reads++;return []; },
    async find() { reads++;return exists ? { contentType: 'image/png',bytes: Buffer.alloc(40,1) } : null; },
  } });
  const handler=module.createHandler({ principalGuard: { async require() { if (!allowed) throw new Error('DENIED');return principal; } },
    tenantGuard: { async requireKnown() { return { tenantId,status: 'active' }; } },maxResponseBytes: 4096 });
  async function call(path=root,{ method='GET',headers={} }={}) {
    const request=Readable.from([]);request.method=method;request.headers=headers;
    const response={ headers: {},setHeader(key,value) { this.headers[key]=value; },end(value) { this.body=value; } };
    await handler({ request,response,path: path.split('?')[0],parsedUrl: new URL(path,full.customerOrigin),requestId: randomUUID() });
    return response;
  }
  const image=await call(`${root}/${assetId}`);assert.equal(image.statusCode,200);assert.equal(image.headers['Content-Type'],'image/png');
  const conditional={ 'if-none-match': image.headers.ETag };
  assert.equal((await call(`${root}/${assetId}`,{ headers: conditional })).statusCode,304);
  allowed=false;const before=reads;await assert.rejects(call(`${root}/${assetId}`,{ headers: conditional }),/DENIED/);
  assert.equal(reads,before);
  allowed=true;exists=false;await assert.rejects(call(`${root}/${assetId}`,{ headers: conditional }),{ statusCode: 404 });
  await assert.rejects(call(root+'?tenant=foreign'),{ statusCode: 400 });
  await assert.rejects(call(root,{ method: 'POST' }),{ statusCode: 405 });
  await assert.rejects(call(root,{ headers: { 'sec-fetch-site': 'cross-site' } }),{ statusCode: 403 });
  await assert.rejects(call(root,{ headers: { 'content-length': '1' } }),{ statusCode: 400 });
  assert.equal(module.routeKey(root+'/not-a-uuid'),null);
});
