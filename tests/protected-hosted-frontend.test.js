import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,symlink,unlink,writeFile } from 'node:fs/promises';
import { createServer,request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readProtectedFrontendArtifact } from '../src/protected-frontend-artifact.js';
import { loadProtectedHostedFrontend,withProtectedHostedFrontend } from '../src/protected-hosted-frontend.js';
import { loadProtectedRuntimeProfile } from '../src/protected-runtime-config.js';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';
import { frontendArtifactDigest,writeProtectedFrontendFixture } from './support/protected-frontend-artifact-fixture.js';

const profile=surface=>({ surface,environment: 'int',apiCommit: 'a'.repeat(40),frontendCommit: 'b'.repeat(40),
  customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com',syntheticEnabled: true });
async function fixture(t,surface='customer',overrides={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'cm-protected-artifact-'));t.after(()=>rm(root,{ recursive: true,force: true }));
  const selected=await writeProtectedFrontendFixture(root,{ ...profile(surface),...overrides });return { root,selected };
}
test('hosted delivery stays disabled by default and needs an external per-surface manifest digest',async()=>{
  assert.equal(await loadProtectedHostedFrontend({ hostedFrontendSha256: null }),null);
  const database=new URL('postgresql://db.example.test/neondb');database.username='cm_protected_int_customer';
  database.password='x'.repeat(48);
  const env={ NODE_ENV: 'production',PROTECTED_ENVIRONMENT: 'int',PROTECTED_SECURITY_EPOCH: 'bc000000-0000-4000-8000-000000000001',
    PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_CUSTOMER_ORIGIN: profile('customer').customerOrigin,
    PROTECTED_PLATFORM_ORIGIN: profile('customer').platformOrigin,PROTECTED_API_COMMIT: 'a'.repeat(40),
    PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),PROTECTED_CUSTOMER_DATABASE_URL: database.href };
  assert.equal(loadProtectedRuntimeProfile(env,{ surface: 'customer' }).hostedFrontendSha256,null);
  for (const change of [{ PROTECTED_HOSTED_FRONTEND_ENABLED: 'true' },{ PROTECTED_HOSTED_FRONTEND_ENABLED: 'yes' },
    { PROTECTED_HOSTED_FRONTEND_SHA256: 'c'.repeat(64) },
    { PROTECTED_HOSTED_FRONTEND_ENABLED: 'false',PROTECTED_HOSTED_FRONTEND_SHA256: 'c'.repeat(64) }]) {
    assert.throws(()=>loadProtectedRuntimeProfile({ ...env,...change },{ surface: 'customer' }),/HOSTED_FRONTEND_INVALID/);
  }
  assert.equal(loadProtectedRuntimeProfile({ ...env,PROTECTED_HOSTED_FRONTEND_ENABLED: 'true',
    PROTECTED_HOSTED_FRONTEND_SHA256: 'c'.repeat(64) },{ surface: 'customer' }).hostedFrontendSha256,'c'.repeat(64));
});
test('both artifact planes pin exact deployment metadata and return isolated captured file buffers',async t=>{
  for (const surface of ['customer','platform']) {
    const { root,selected }=await fixture(t,surface),artifact=await readProtectedFrontendArtifact(root,selected);
    assert.ok(Object.isFrozen(artifact));assert.match(artifact.csp,/frame-ancestors 'none'/);
    const first=artifact.get(artifact.entry),expected=Buffer.from(first.bytes);first.bytes.fill(0);
    assert.deepEqual(artifact.get(artifact.entry).bytes,expected);
    for (const change of [{ surface: surface==='customer' ? 'platform' : 'customer' },{ environment: 'prod' },
      { apiCommit: 'd'.repeat(40) },{ frontendCommit: 'e'.repeat(40) },{ customerOrigin: 'https://foreign.example.test' },
      { platformOrigin: 'https://foreign.example.test' },{ syntheticEnabled: false },
      { ownerCustomerAccessEnabled: true },{ hostedFrontendSha256: 'f'.repeat(64) }]) {
      await assert.rejects(readProtectedFrontendArtifact(root,{ ...selected,...change }),/ARTIFACT_INVALID/);
    }
    await writeFile(path.join(root,artifact.entry),'changed after immutable startup');
    assert.deepEqual(artifact.get(artifact.entry).bytes,expected);
  }
});
test('Pavurel INT serving requires freshly sealed origins and rejects old and sibling hosts on both surfaces',async t=>{
  const origins={ customerOrigin: 'https://app.int.pavurel.eu',platformOrigin: 'https://platform.int.pavurel.eu' };
  const oldOrigins={ customerOrigin: 'https://conference-manager-demo.onrender.com',
    platformOrigin: 'https://conference-manager-ops-demo.onrender.com' };
  for (const surface of ['customer','platform']) {
    const old=await fixture(t,surface,oldOrigins);
    await assert.rejects(readProtectedFrontendArtifact(old.root,{ ...old.selected,...origins }),/ARTIFACT_INVALID/);
    const { root,selected }=await fixture(t,surface,origins),artifact=await readProtectedFrontendArtifact(root,selected);
    const own=origins[`${surface}Origin`],peer=origins[surface==='customer' ? 'platformOrigin' : 'customerOrigin'];
    const entry=surface==='customer' ? '/' : '/platform-admin/';
    const server=createServer(withProtectedHostedFrontend({ profile: selected,config: { mode: 'production',publicOrigin: own },
      artifact,apiHandler: ()=>assert.fail('STATIC_REQUEST_CANNOT_ENTER_API') }));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const exchange=(target=entry,headers={})=>new Promise((resolve,reject)=>{
      const call=request({ hostname: '127.0.0.1',port: server.address().port,path: target,
        headers: { host: new URL(own).host,...headers } },response=>{
        response.resume();response.once('end',()=>resolve({ status: response.statusCode,headers: response.headers }));
      });call.once('error',reject);call.end();
    });
    const response=await exchange(entry,{ origin: own });assert.equal(response.status,200);
    assert.equal(response.headers['cross-origin-resource-policy'],'same-origin');
    assert.equal(response.headers['access-control-allow-origin'],undefined);
    if (surface==='platform') {
      const redirect=await exchange('/');assert.equal(redirect.status,303);assert.equal(redirect.headers.location,'/platform-admin/');
    }
    for (const host of [new URL(oldOrigins[`${surface}Origin`]).host,new URL(peer).host,`${new URL(own).host}.foreign.test`]) {
      assert.equal((await exchange(entry,{ host })).status,400);
    }
    assert.equal((await exchange(entry,{ origin: peer })).status,403);
    assert.equal((await exchange(entry,{ origin: oldOrigins[`${surface}Origin`] })).status,403);
  }
});
test('modified bytes, a recomputed manifest without an external pin and extra files cannot be adopted',async t=>{
  const { root,selected }=await fixture(t),raw=await readFile(path.join(root,'manifest.json'));
  await writeFile(path.join(root,'assets/fixture.css'),'corrupt');
  await assert.rejects(readProtectedFrontendArtifact(root,selected),/ARTIFACT_INVALID/);
  const manifest=JSON.parse(raw);manifest.files[0].bytes=7;manifest.files[0].sha256=frontendArtifactDigest(Buffer.from('corrupt'));
  await writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest)+'\n');
  await assert.rejects(readProtectedFrontendArtifact(root,selected),/ARTIFACT_INVALID/);
  await writeProtectedFrontendFixture(root,profile('customer'));await writeFile(path.join(root,'secret.txt'),'private');
  await assert.rejects(readProtectedFrontendArtifact(root,selected),/ARTIFACT_INVALID/);
});
test('symlink files and directories and unsafe or foreign-plane manifest paths fail closed',async t=>{
  const { root,selected }=await fixture(t);await unlink(path.join(root,'assets/fixture.css'));
  await symlink(path.join(root,'index.html'),path.join(root,'assets/fixture.css'));
  await assert.rejects(readProtectedFrontendArtifact(root,selected),/ARTIFACT_INVALID/);
  await assert.rejects(readProtectedFrontendArtifact('relative',selected),/ARTIFACT_INVALID/);
  await unlink(path.join(root,'assets/fixture.css'));await writeProtectedFrontendFixture(root,profile('customer'));
  await rm(path.join(root,'assets'),{ recursive: true });await symlink(root,path.join(root,'assets'));
  await assert.rejects(readProtectedFrontendArtifact(root,selected),/ARTIFACT_INVALID/);
  await unlink(path.join(root,'assets'));await writeProtectedFrontendFixture(root,profile('customer'));
  for (const name of ['../outside.js','src/platform-admin/production/bootstrap.js','src/platform/demo-bootstrap.js','tests/key.js']) {
    const manifest=JSON.parse(await readFile(path.join(root,'manifest.json')));manifest.files[0].path=name;
    const raw=Buffer.from(JSON.stringify(manifest)+'\n');await writeFile(path.join(root,'manifest.json'),raw);
    await assert.rejects(readProtectedFrontendArtifact(root,
      { ...selected,hostedFrontendSha256: frontendArtifactDigest(raw) }),/ARTIFACT_INVALID/);
  }
});
test('HTTP delivery validates Host, target, method and body while retaining the exact API handler and default behavior',async t=>{
  const { root,selected }=await fixture(t),artifact=await readProtectedFrontendArtifact(root,selected);let calls=0;
  const apiHandler=(_request,response)=>{ calls++;response.writeHead(418);response.end(); };
  const config={ mode: 'production',publicOrigin: selected.customerOrigin };
  assert.equal(withProtectedHostedFrontend({ profile: selected,config,artifact: null,apiHandler }),apiHandler);
  const server=createServer(withProtectedHostedFrontend({ profile: selected,config,artifact,apiHandler }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  async function exchange(target,options={}) {
    return new Promise((resolve,reject)=>{
      const call=request({ hostname: '127.0.0.1',port: server.address().port,path: target,method: options.method ?? 'GET',
        headers: { host: 'app-int.example.test',...options.headers } },response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.once('end',()=>resolve({
          status: response.statusCode,headers: response.headers,bytes: Buffer.concat(chunks) }));
      });call.once('error',reject);call.end(options.body);
    });
  }
  const html=await exchange('/');assert.equal(html.status,200);assert.equal(html.headers['cache-control'],'no-store');
  assert.equal(html.headers['cross-origin-resource-policy'],'same-origin');
  const print=await exchange('/src/shared/detached-print.html');
  assert.equal(print.status,200);assert.equal(print.headers['content-type'],'text/html; charset=utf-8');
  assert.equal(print.headers['content-disposition'],undefined);assert.match(print.bytes.toString(),/<!doctype html>/i);
  assert.match(html.headers['content-security-policy'],/frame-ancestors/);
  assert.equal((await exchange('/assets/fixture.css?v=reviewed')).status,200);
  assert.equal((await exchange('/',{ method: 'HEAD' })).bytes.length,0);
  for (const target of ['/manifest.json','/scripts/build.mjs','/platform-admin/','/missing',
    '/%2e%2e/index.html','//foreign.example.test/']) {
    assert.ok((await exchange(target)).status>=400,target);
  }
  assert.equal((await exchange('/',{ headers: { host: 'foreign.example.test' } })).status,400);
  assert.equal((await exchange('/',{ headers: { origin: selected.platformOrigin } })).status,403);
  assert.equal((await exchange('/',{ method: 'POST' })).status,405);
  assert.equal((await exchange('/',{ headers: { 'content-length': '1' },body: 'x' })).status,400);
  assert.equal((await exchange('/api/v1/session')).status,418);assert.equal(calls,1);
});
test('protected artifact and serving modules cannot enter lower layers or closed Demo compositions',()=>{
  for (const target of ['src/protected-frontend-artifact.js','src/protected-hosted-frontend.js']) {
    for (const source of ['src/domain/probe.js','src/application/probe.js','src/demo/customer-main.js','src/demo/platform-main.js']) {
      assert.ok(moduleBoundaryViolations({ [source]: `import '../${target.split('/').at(-1)}';`,
        [target]: 'export const x=true;' }).length>0,`${source} -> ${target}`);
    }
  }
});

test('static budget admits complete cold graph navigations and then limits assets without blocking protected API routing',async t=>{
  const { root,selected }=await fixture(t),artifact=await readProtectedFrontendArtifact(root,selected);let apiCalls=0;
  const server=createServer(withProtectedHostedFrontend({ profile: selected,config: {
    mode: 'production',publicOrigin: selected.customerOrigin },artifact,apiHandler: (_request,response)=>{
    apiCalls++;response.writeHead(418);response.end();
  } }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  async function status(target) {
    return new Promise((resolve,reject)=>{
      const call=request({ hostname: '127.0.0.1',port: server.address().port,path: target,
        headers: { host: 'app-int.example.test' } },response=>{
        response.resume();response.once('end',()=>resolve(response.statusCode));
      });call.once('error',reject);call.end();
    });
  }
  for (let navigation=0;navigation<16;navigation++) {
    assert.equal(await status('/'),200);assert.equal(await status('/assets/fixture.css'),200);
    assert.equal(await status('/src/shared/detached-print.html'),200);
  }
  assert.equal(await status('/assets/fixture.css'),429);
  assert.equal(await status('/api/v1/session'),418);assert.equal(apiCalls,1);
});
