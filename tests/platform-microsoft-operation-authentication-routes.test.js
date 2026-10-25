import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPlatformMicrosoftOperationAuthenticationRoutes,PLATFORM_MICROSOFT_OPERATION_STATUS as STATUS,
  PLATFORM_MICROSOFT_OPERATION_COMPLETE as COMPLETE } from '../src/platform/http/microsoft-operation-authentication-routes.js';
import { PLATFORM_MICROSOFT_OPERATION_CALLBACK as CALLBACK,serializePlatformMicrosoftOperationBrowserCookie,
  serializePlatformMicrosoftOperationCookie,clearPlatformMicrosoftOperationBrowserCookie,clearPlatformMicrosoftOperationCookie }
  from '../src/platform/identity/microsoft-operation-cookie.js';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';

const state=Buffer.alloc(32,1).toString('base64url'),mac=Buffer.alloc(32,2).toString('base64url');
const cookie=`${state}.${mac}`,callbackCookie=serializePlatformMicrosoftOperationBrowserCookie(cookie);
const operationCookie=serializePlatformMicrosoftOperationCookie(cookie,120),requestId='11111111-1111-4111-8111-111111111111';
function fixture() {
  let authenticated=true,status='pending',failure=false,completion=null;const calls=[];
  const module=createPlatformMicrosoftOperationAuthenticationRoutes({ async complete(value) {
    calls.push(['callback',value]);if (failure) throw new Error('private-provider-failure');
    return completion ?? { status: 'operation_verified',setCookies: [clearPlatformMicrosoftOperationBrowserCookie(),operationCookie] };
  },async pendingStatus(value) {
    calls.push(['status',value]);if (failure) throw new PlatformIdentityError('PLATFORM_MICROSOFT_OPERATION_REJECTED');
    if (value.cookie!==cookie) throw new PlatformIdentityError('PLATFORM_MICROSOFT_OPERATION_REJECTED');return { status };
  } },{ environment: 'int' });
  const handler=module.createHandler({ maxResponseBytes: 4096,maxBodyBytes: 4096,platformPrincipalGuard: {
    async require(_request,options) { calls.push(['guard',options]);
      if (!authenticated) throw new PlatformIdentityError('PLATFORM_SESSION_REQUIRED');return {};
    },
  } });
  async function invoke(path,{ method='GET',body,headers={} }={}) {
    const bytes=body===undefined ? null : Buffer.from(JSON.stringify(body)),request=Readable.from(bytes===null ? [] : [bytes]);
    request.method=method;request.headers={ ...(bytes===null ? {} : {
      'content-type': 'application/json','content-length': String(bytes.length) }),...headers };
    const response={ headers: {},setHeader(name,value) { this.headers[name.toLowerCase()]=value; },
      removeHeader(name) { delete this.headers[name.toLowerCase()]; },end(value) { this.body=value; } };
    const parsedUrl=new URL(path,'https://operations.example.test');
    try { response.result=await handler({ path: parsedUrl.pathname,parsedUrl,request,response,requestId }); }
    catch (error) { response.error=error; }return response;
  }
  return { invoke,calls,module,authenticate: value=>{ authenticated=value; },status: value=>{ status=value; },
    fail: ()=>{ failure=true; },completion: value=>{ completion=value; } };
}
test('different-site callback needs only its narrow Lax cookie and always scrubs provider query without business authority',async()=>{
  const f=fixture();f.authenticate(false);
  const result=await f.invoke(`${CALLBACK}?state=${state}&code=synthetic-code`,{ headers: { cookie: callbackCookie.split(';')[0] } });
  assert.equal(result.result,303);assert.equal(result.headers.location,COMPLETE);
  assert.deepEqual(f.calls.map(call=>call[0]),['callback']);assert.equal(f.calls[0][1].cookie,cookie);
  assert.equal(f.calls[0][1].request,undefined);assert.deepEqual(result.headers['set-cookie'],[
    clearPlatformMicrosoftOperationBrowserCookie(),operationCookie]);
  assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['referrer-policy'],'no-referrer');
  const page=await f.invoke(COMPLETE);assert.equal(page.result,200);
  assert.match(page.body,/<main>/);assert.doesNotMatch(page.body,/script|postMessage|opener|synthetic-code|cm_platform_session/);
});
test('provider rejection, malformed callback and unexpected failure clear both cookies and never claim verification',async()=>{
  for (const path of [`${CALLBACK}?state=${state}&error=access_denied`,`${CALLBACK}?state=${state}&code=code&roles=owner`,
    `${CALLBACK}?state=${state}&state=${state}&code=code`]) {
    const f=fixture();f.fail();const result=await f.invoke(path,{ headers: { cookie: callbackCookie.split(';')[0] } });
    assert.equal(result.result,303);assert.equal(result.headers.location,COMPLETE);
    assert.deepEqual(result.headers['set-cookie'],[clearPlatformMicrosoftOperationBrowserCookie(),clearPlatformMicrosoftOperationCookie()]);
    assert.equal(result.body,undefined);
  }
  const f=fixture();f.completion({ status: 'operation_verified',principal: {},setCookies: [callbackCookie,operationCookie] });
  assert.equal((await f.invoke(`${CALLBACK}?state=${state}&code=code`)).headers['set-cookie'][1],clearPlatformMicrosoftOperationCookie());
});
test('status is closed, CSRF-protected POST with current Strict source and MAC; completion has no query or body',async()=>{
  const f=fixture(),input={ method: 'POST',body: { state },headers: { cookie: operationCookie.split(';')[0] } };
  assert.equal((await f.invoke(STATUS)).error.statusCode,405);
  f.authenticate(false);assert.ok((await f.invoke(STATUS,input)).error);assert.equal(f.calls.some(call=>call[0]==='status'),false);
  f.authenticate(true);const pending=await f.invoke(STATUS,input);assert.equal(pending.result,200);
  assert.deepEqual(JSON.parse(pending.body),{ status: 'pending',requestId });assert.equal(f.calls.at(-2)[1].csrf,true);
  f.status('verified');assert.equal(JSON.parse((await f.invoke(STATUS,input)).body).status,'verified');
  for (const change of [{ body: { state,roles: ['owner'] } },{ body: { state: state+'=' } },{ headers: { cookie: callbackCookie } }]) {
    assert.ok((await f.invoke(STATUS,{ ...input,...change })).error);
  }
  assert.ok((await f.invoke(COMPLETE+'?state='+state)).error);
  assert.ok((await f.invoke(COMPLETE,{ body: { state } })).error);
  f.status('consumed');assert.ok((await f.invoke(STATUS,input)).error);
});
