import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createProtectedHttpExecutionHandler } from '../src/transport/protected-http-execution.js';
import { protectedPlatformExecutionBoundary } from '../src/platform/http/protected-execution-boundary.js';
import { ProtectedRuntimeGateError } from '../src/persistence/postgres/protected-runtime-gate.js';

const config=Object.freeze({ mode: 'test',publicOrigin: 'https://localhost',maxBodyBytes: 1024,requestTimeoutMs: 1000,
  rateLimitMax: 100,rateLimitWindowMs: 60000,rateLimitMaxKeys: 10 });
function deferred() { let resolve;const promise=new Promise(done=>{ resolve=done; });return { promise,resolve }; }
async function fixture(t,{ surface='customer',app,scopes,overrides={} }={}) {
  let active=false,leases=0,calls=0;const bodies=[];
  const handler=createProtectedHttpExecutionHandler({ config: { ...config,...overrides },surface,
    platformBoundary: surface==='platform' ? protectedPlatformExecutionBoundary : null,
    executionScopes: scopes || { async withShared(work) {
      assert.equal(active,false);active=true;leases++;
      try { return await work(); } finally { active=false; }
    } },app: app || (async(request,response)=>{
      calls++;bodies.push({ active,method: request.method,url: request.url,headers: request.headers });
      const chunks=[];for await (const chunk of request) chunks.push(chunk);
      bodies.at(-1).text=Buffer.concat(chunks).toString('utf8');
      await assert.rejects(async()=>{ for await (const _chunk of request) assert.fail('NO_SECOND_READ'); },
        /PROTECTED_HTTP_BODY_ALREADY_READ/);
      response.end('ok');
    }) });
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  function request(path='/api/v1/session',{ method='GET',body,headers={} }={}) {
    return new Promise((resolve,reject)=>{
      const outgoing=http.request({ host: '127.0.0.1',port: server.address().port,path,method,
        headers: { host: 'localhost',...(method==='GET' ? {} : { origin: config.publicOrigin }),...headers } },response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({ status: response.statusCode,
          headers: response.headers,text: Buffer.concat(chunks).toString('utf8') }));
      });outgoing.on('error',reject);outgoing.end(body);
    });
  }
  return { server,request,bodies,current: ()=>({ active,leases,calls }) };
}

test('protected HTTP holds one lease across the whole awaited app and replays bounded bytes without changing the source request',async t=>{
  const f=await fixture(t);assert.equal((await f.request()).status,200);
  const answer=await f.request('/api/v1/requests',{ method: 'POST',body: '{"safe":"body"}',
    headers: { 'content-type': 'application/json',cookie: 'opaque-cookie','x-csrf-token': 'opaque-csrf' } });
  assert.equal(answer.status,200);assert.equal(f.bodies[1].text,'{"safe":"body"}');
  assert.equal(f.bodies[1].headers.cookie,'opaque-cookie');assert.equal(f.bodies[1].headers['x-csrf-token'],'opaque-csrf');
  assert.deepEqual(f.current(),{ active: false,leases: 2,calls: 2 });assert.equal(f.bodies.every(x=>x.active),true);
});

test('wrong host, origin, traversal, method, declared/streamed bounds and encoding fail before leases or authentication',async t=>{
  const f=await fixture(t);
  for (const [path,options,status] of [
    ['/api/v1/session',{ headers: { host: 'foreign.invalid' } },400],
    ['/api/v1/session',{ headers: { origin: 'https://foreign.invalid' } },403],
    ['/api/%2e%2e/session',{},400],['/api/v1/session',{ method: 'TRACE' },405],
    ['/api/v1/session',{ method: 'POST',body: 'x',headers: { 'content-length': '1025' } },413],
    ['/api/v1/session',{ method: 'POST',body: 'x'.repeat(1025) },413],
    ['/api/v1/session',{ method: 'POST',body: 'x',headers: { 'content-encoding': 'gzip' } },415],
  ]) assert.equal((await f.request(path,options)).status,status);
  assert.deepEqual(f.current(),{ active: false,leases: 0,calls: 0 });
});

test('only exact Platform exclusive POST paths and canonical health probes omit the outer shared lease',async t=>{
  const f=await fixture(t,{ surface: 'platform' });
  for (const path of ['/api/v1/platform/synthetic/generation/replace','/api/v1/platform/auth/delegation/approve']) {
    assert.equal((await f.request(path,{ method: 'POST',body: '{}' })).status,200);
    assert.equal(f.bodies.at(-1).active,false);
    assert.equal((await f.request(path)).status,200);assert.equal(f.bodies.at(-1).active,true);
  }
  await f.request('/api/v1/platform/health/live');assert.equal(f.bodies.at(-1).active,false);
  await f.request('/api/v1/platform/health/live?foreign=1');assert.equal(f.bodies.at(-1).active,true);
  await f.request('/api/v1/platform/auth/delegation/options',{ method: 'POST',body: '{}' });
  assert.equal(f.bodies.at(-1).active,true);
  const customer=await fixture(t);await customer.request('/api/v1/platform/synthetic/generation/replace',{ method: 'POST',body: '{}' });
  assert.equal(customer.bodies.at(-1).active,true);
});

test('body arrival and local rate denial allocate no shared lease; partial upload expires without entering the app',async t=>{
  const f=await fixture(t,{ overrides: { rateLimitMax: 1 } });
  assert.equal((await f.request()).status,200);assert.equal((await f.request()).status,429);
  assert.equal(f.current().leases,1);
  const stage=await fixture(t),started=deferred();
  const pending=new Promise((resolve,reject)=>{
    const outgoing=http.request({ host: '127.0.0.1',port: stage.server.address().port,path: '/api/v1/requests',method: 'POST',
      headers: { host: 'localhost',origin: config.publicOrigin,'content-length': '2' } },response=>{
      response.resume();response.on('end',()=>resolve(response.statusCode));
    });outgoing.on('error',reject);outgoing.write('x');started.resolve();
  });
  await started.promise;assert.equal(stage.current().leases,0);assert.equal(await pending,408);
  assert.deepEqual(stage.current(),{ active: false,leases: 0,calls: 0 });
});

test('gate failures close safely without invoking the app or leaking a cookie or infrastructure details',async t=>{
  const f=await fixture(t,{ scopes: { withShared() { throw new ProtectedRuntimeGateError('PROTECTED_RUNTIME_SCOPE_STALE'); } } });
  const answer=await f.request();assert.equal(answer.status,503);assert.equal(answer.headers['set-cookie'],undefined);
  assert.equal(JSON.parse(answer.text).error.code,'PROTECTED_RUNTIME_UNAVAILABLE');assert.equal(f.current().calls,0);
  const broken=await fixture(t,{ app: async(_request,response)=>{ response.setHeader('Set-Cookie','sensitive');
    throw new Error('private-infrastructure-detail'); } });
  const failed=await broken.request();assert.equal(failed.status,500);assert.equal(failed.headers['set-cookie'],undefined);
  assert.equal(failed.text.includes('private-infrastructure-detail'),false);
  for (const patch of [{ demoRuntime: true },{ mode: 'demo' },{ publicOrigin: 'http://localhost' },{ rateLimitMax: undefined }]) {
    assert.throws(()=>createProtectedHttpExecutionHandler({ config: { ...config,...patch },surface: 'customer',
      executionScopes: { withShared: work=>work() },app() {} }),/CONFIGURATION_INVALID/);
  }
});
