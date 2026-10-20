import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { requireProtectedRuntimeSharedExecutionScope }
  from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPlatformApp } from '../src/platform/app.js';
import { platformSessionRoutes } from '../src/platform/http/session-routes.js';
import { createPlatformLogger } from '../src/platform/http/observability.js';
import { protectedPlatformExecutionBoundary } from '../src/platform/http/protected-execution-boundary.js';
import { createProtectedHttpExecutionHandler } from '../src/transport/protected-http-execution.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

function deferred() { let resolve;const promise=new Promise(done=>{ resolve=done; });return { promise,resolve }; }

test('native max1 HTTP fences actual session resolution through response work and denies stale epochs before app entry',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const control=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end(),control.end()]); });await migrateUp(pool);
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const entered=deferred(),release=deferred(),logs=[];let resolutions=0,hold=true;
  const config={ mode: 'test',publicOrigin: 'https://ops-int.example.com',serviceVersion: '0.1.0',buildId: 'protected-http-fixture',
    entraAuthority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',entraClientId: randomUUID(),
    entraRedirectUri: 'https://ops-int.example.com/api/v1/platform/auth/microsoft/callback',
    mfaAuthenticationContext: 'c1',stepUpAuthenticationContext: 'c2',authenticationMaxAgeSeconds: 900,
    maxBodyBytes: 32768,maxResponseBytes: 65536,rateLimitMax: 100,rateLimitWindowMs: 60000,rateLimitMaxKeys: 100,
    requestTimeoutMs: 5000,headersTimeoutMs: 5000,keepAliveTimeoutMs: 1000 };
  const app=createPlatformApp({ config,routeModules: [platformSessionRoutes],
    logger: createPlatformLogger({ write: line=>logs.push(line) }),
    platformSessionService: { ...owner.sessions,async resolvePrincipal(request) {
      requireProtectedRuntimeSharedExecutionScope(pool,scope);resolutions++;
      const principal=await owner.sessions.resolvePrincipal(request);
      assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value,1);
      if (hold) { entered.resolve();await release.promise; }
      requireProtectedRuntimeSharedExecutionScope(pool,scope);return principal;
    } },platformAuditService: { createUnmappedAuthenticationFailure: value=>value,createDeniedEvent: value=>value,
      async record() { assert.fail('NO_DENIAL_AUDIT_FOR_VALID_SESSION'); } } });
  const server=http.createServer(createProtectedHttpExecutionHandler({ config,surface: 'platform',
    executionScopes: owner.scopes,platformBoundary: protectedPlatformExecutionBoundary,app }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  function request(headers={}) {
    return new Promise((resolve,reject)=>{
      const outgoing=http.request({ hostname: '127.0.0.1',port: server.address().port,path: '/api/v1/platform/session',
        headers: { host: 'ops-int.example.com',cookie: owner.current().setCookie.split(';')[0],...headers } },incoming=>{
        const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>resolve({ status: incoming.statusCode,
          headers: incoming.headers,text: Buffer.concat(chunks).toString('utf8') }));
      });outgoing.on('error',reject);outgoing.end();
    });
  }
  assert.equal((await request({ host: 'foreign.invalid' })).status,400);assert.equal(resolutions,0);
  const pending=request();await Promise.race([entered.promise,pending.then(()=>{ throw new Error('SESSION_NOT_ENTERED'); })]);
  try { await assert.rejects(control.query("SELECT protected_runtime_acquire_exclusive('int')"),/PROTECTED_RUNTIME_BUSY/); }
  finally { hold=false;release.resolve(); }
  const answer=await pending;assert.equal(answer.status,200);assert.equal(resolutions,1);
  assert.equal(JSON.parse(answer.text).operatorId,owner.operatorId);
  await control.query("SELECT protected_runtime_acquire_exclusive('int')");
  await control.query("UPDATE protected_runtime_deployments SET security_epoch=$1 WHERE environment='int'",[randomUUID()]);
  const stale=await request();assert.equal(stale.status,503);assert.equal(resolutions,1);
  assert.equal(stale.headers['set-cookie'],undefined);assert.equal(JSON.parse(stale.text).error.code,'PROTECTED_RUNTIME_UNAVAILABLE');
  assert.equal(logs.join('').includes(owner.current().setCookie.split(';')[0]),false);
});
