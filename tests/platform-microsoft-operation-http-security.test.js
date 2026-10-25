import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { createPlatformMicrosoftOperationAuthenticationRoutes }
  from '../src/platform/http/microsoft-operation-authentication-routes.js';
import { clearPlatformMicrosoftOperationBrowserCookie,serializePlatformMicrosoftOperationCookie }
  from '../src/platform/identity/microsoft-operation-cookie.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const id='11111111-1111-4111-8111-111111111111',origin='https://operations.example.test';
const base='/api/v1/platform/auth/microsoft/operation',state=Buffer.alloc(32,1).toString('base64url');
const roles=['platform_security_admin'],now=new Date().toISOString(),cookie=`${state}.${state}`;
const principal={ operatorId: id,securityVersion: 1,roles,permissions: permissionsForPlatformRoles(roles),
  targetScope: { mode: 'all',securityVersion: 1 },providerIdentity: { provider: 'microsoft_entra_platform',
    tenantReference: id,subjectReference: id },assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',authenticatedAt: now },
  session: { id,securityVersion: 1,securityEpoch: 7,issuedAt: now,
    expiresAt: new Date(Date.now()+3600000).toISOString(),stepUpExpiresAt: null } };
test('real Microsoft callback/status HTTP preserves host, origin, CSRF, cookie, CSP, COOP and minimized output boundaries',async t=>{
  const callbacks=[],statuses=[],logs=[];
  const route=createPlatformMicrosoftOperationAuthenticationRoutes({ async complete(value) {
    callbacks.push(value);return { status: 'operation_verified',setCookies: [clearPlatformMicrosoftOperationBrowserCookie(),
      serializePlatformMicrosoftOperationCookie(cookie,120)] };
  },async pendingStatus(value) { statuses.push(value);return { status: 'verified' }; } },{ environment: 'int' });
  const config={ mode: 'test',serviceVersion: '1.0.0',buildId: 'synthetic-http',publicOrigin: origin,
    entraAuthority: `https://login.microsoftonline.com/${id}`,entraClientId: id,
    entraRedirectUri: origin+'/api/v1/platform/auth/microsoft/callback',mfaAuthenticationContext: 'cm:ms:mfa:v1',
    stepUpAuthenticationContext: 'cm:ms:fresh:v1',authenticationMaxAgeSeconds: 300,maxBodyBytes: 4096,maxResponseBytes: 65536,
    rateLimitMax: 100,rateLimitWindowMs: 60000,rateLimitMaxKeys: 100,
    requestTimeoutMs: 5000,headersTimeoutMs: 5000,keepAliveTimeoutMs: 1000 };
  const server=createPlatformHttpServer({ config,routeModules: [route],requestIdFactory: ()=>id,
    logger: { requestCompleted: value=>logs.push(value),securityOutcome: value=>logs.push(value),unhandledError: value=>logs.push(value) },
    platformSessionService: { async resolvePrincipal(request) {
      return request.headers.cookie?.includes('cm_platform_session=synthetic') ? principal : null;
    },async verifyCsrf(request) { return request.headers['x-csrf-token']==='C'.repeat(43); } },
    platformAuditService: { createUnmappedAuthenticationFailure: value=>value,createDeniedEvent: value=>value,async record() {} } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  function request(path,{ method='GET',body,headers={} }={}) {
    return new Promise((resolve,reject)=>{
      const data=body===undefined ? null : JSON.stringify(body),out=http.request({ hostname: '127.0.0.1',port: server.address().port,
        path,method,headers: { host: 'operations.example.test',...(data===null ? {} : {
          'content-type': 'application/json','content-length': Buffer.byteLength(data) }),...headers } },response=>{
        let text='';response.on('data',value=>{ text+=value; });response.on('end',()=>resolve({ status: response.statusCode,
          headers: response.headers,text }));
      });out.on('error',reject);out.end(data);
    });
  }
  const input={ method: 'POST',body: { state },headers: { origin,'x-csrf-token': 'C'.repeat(43),
    cookie: `cm_platform_session=synthetic; cm_platform_ms_operation=${cookie}` } };
  for (const [headers,expected] of [[{},403],[{ origin },401],[{ ...input.headers,origin: 'https://evil.example' },403],
    [{ ...input.headers,'x-csrf-token': 'wrong' },403],[{ ...input.headers,host: 'evil.example' },400]]) {
    assert.equal((await request(base+'/status',{ ...input,headers })).status,expected);
  }
  assert.equal(statuses.length,0);const result=await request(base+'/status',input);
  assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.text),{ status: 'verified',requestId: id });
  assert.equal(statuses.length,1);assert.equal(statuses[0].cookie,cookie);
  assert.equal(result.headers['cross-origin-opener-policy'],'same-origin');assert.equal(result.headers['cache-control'],'no-store');
  assert.match(result.headers['content-security-policy'],/default-src 'none'/);
  assert.equal((await request(base+'/configuration')).status,401);
  assert.deepEqual(JSON.parse((await request(base+'/configuration',{ headers: input.headers })).text),
    { mode: 'microsoft_mfa',environment: 'int' });
  const callback=await request(base+`/callback?state=${state}&code=synthetic-provider-code`,{
    headers: { cookie: `cm_platform_ms_operation_tx=${cookie}` } });
  assert.equal(callback.status,303);assert.equal(callback.headers.location,base+'/complete');assert.equal(callbacks.length,1);
  assert.equal(callbacks[0].request,undefined);assert.equal(callback.headers['referrer-policy'],'no-referrer');
  assert.equal(callback.headers['set-cookie'].some(value=>value.startsWith('cm_platform_session=')),false);
  assert.doesNotMatch(JSON.stringify(logs),/synthetic-provider-code|cm_platform_ms_operation|synthetic-normal|code=/);
});
