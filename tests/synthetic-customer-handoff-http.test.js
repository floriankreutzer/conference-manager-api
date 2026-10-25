import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { serializeClearedSessionCookie } from '../src/identity/session-cookie.js';
import { customerHandoffHttpFixture as fixture } from './support/customer-handoff-http-fixture.js';

const ORIGIN='https://127.0.0.1';

test('loopback callback preserves private browser custody and scrubs code without a session GET',async t=>{
  const f=await fixture(t),answer=await f.request();assert.equal(answer.status,303);
  const target=new URL(answer.headers.location);assert.equal(target.origin,f.scope.platformOrigin);
  assert.equal(target.pathname,'/api/v1/platform/auth/delegation/arrive');
  assert.equal(target.searchParams.get('flow'),f.flowId);assert.equal(target.searchParams.get('state'),f.start.state);
  assert.doesNotMatch(target.href,new RegExp(f.start.browserToken));
  assert.match(answer.headers['set-cookie'][0],/Path=\/api\/v1\/auth\/delegation; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
  assert.match(answer.headers['set-cookie'][1],/cm_synthetic_completion=;.*Max-Age=0/);
  assert.equal(f.calls[0].input,'127.0.0.1');
  const callback=await f.request(`/callback?state=${f.start.state}&code=${f.code.code}`,{ method: 'GET',body: null,
    headers: { cookie: f.originalCookie,origin: undefined,'sec-fetch-site': 'cross-site' } });
  assert.equal(callback.status,303);assert.equal(callback.headers.location,'/?auth=synthetic_confirmation');
  assert.match(callback.headers['set-cookie'][0],/SameSite=Strict; Secure; Max-Age=30$/);
  assert.equal(callback.headers['cache-control'],'no-store');assert.equal(callback.headers['referrer-policy'],'no-referrer');
  assert.doesNotMatch(callback.headers['set-cookie'].join(';'),/cm_session=/);
  assert.deepEqual(f.calls.at(-1).input,{ flowId: f.flowId,browserToken: f.start.browserToken,state: f.start.state,code: f.code.code });
  const view=await f.request('/confirmation',{ method: 'GET',body: null,
    headers: { cookie: `${f.originalCookie}; ${f.completionCookie}` } });
  assert.equal(view.status,200);
  assert.deepEqual(Object.keys(JSON.parse(view.text)).sort(),['accountSwitchRequired','csrfToken','requestId','role','slot']);
  assert.doesNotMatch(view.text,new RegExp(`${f.code.code}|${f.flowId}|${f.start.state}|${f.start.browserToken}`));
  assert.equal(f.calls.some(call=>call.name==='complete'),false);
  assert.doesNotMatch(f.logs.join(''),
    new RegExp(`${f.code.code}|${f.flowId}|${f.start.state}|${f.start.browserToken}|${f.signed.csrfToken}`));
});

test('final same-origin POST forwards the current ordinary cookie and emits only committed session plus cleanup redirect',async t=>{
  const f=await fixture(t);let release,entered,settled=false;
  f.state.block=new Promise(resolve=>{ release=resolve; });const seen=new Promise(resolve=>{ entered=resolve; });f.state.entered=entered;
  const cookie=`${f.originalCookie}; ${f.completionCookie}; ${f.ordinaryCookie.split(';')[0]}`;
  const pending=f.request('/complete',{ headers: { cookie,'x-csrf-token': f.signed.csrfToken } })
    .then(value=>{ settled=true;return value; });
  await seen;assert.equal(settled,false);assert.equal(f.calls.at(-1).input.request.headers.cookie,cookie);
  assert.equal(f.calls.at(-1).input.csrfToken,f.signed.csrfToken);release();
  const answer=await pending;assert.equal(answer.status,303);assert.equal(answer.headers.location,'/');assert.equal(answer.text,'');
  assert.equal(answer.headers['set-cookie'][0],f.ordinaryCookie);
  assert.equal(answer.headers['set-cookie'].filter(value=>/Max-Age=0/.test(value)).length,2);
  assert.match(f.calls.at(-1).input.correlationId,/^[a-f0-9-]{36}$/);
  f.state.block=null;f.state.complete=new Error('SYNTHETIC_HANDOFF_LOGOUT_REQUIRED');
  const denied=await f.request('/complete',{ headers: { cookie,'x-csrf-token': f.signed.csrfToken } });
  assert.equal(denied.status,409);assert.match(denied.text,/AUTHENTICATION_LOGOUT_REQUIRED/);
  assert.equal(denied.headers['set-cookie'],undefined);
});

test('unsafe authority/origin/body/cookie/CSRF is rejected before calling the private service',async t=>{
  const f=await fixture(t),cookie=`${f.originalCookie}; ${f.completionCookie}`;
  for (const [path,options] of [
    ['/start',{ headers: { origin: undefined } }],['/start',{ headers: { origin: 'https://foreign.test' } }],
    ['/start',{ headers: { 'sec-fetch-site': 'cross-site' } }],['/start?tenantId=foreign',{}],
    ['/start',{ body: { role: 'tenant_admin' } }],['/start',{ headers: { 'content-type': 'text/plain' } }],
    ['/start',{ body: { padding: 'x'.repeat(1200) } }],['/complete',{}],
    ['/complete',{ headers: { cookie } }],['/complete',{ headers: { cookie,'x-csrf-token': 'wrong' } }],
    ['/complete',{ body: { tenantId: randomUUID() },headers: { cookie,'x-csrf-token': f.signed.csrfToken } }],
    ['/confirmation',{ method: 'GET',body: null,headers: { cookie: `${cookie}; ${f.originalCookie}` } }],
    ['/confirmation',{ method: 'GET',body: null,headers: { cookie: f.originalCookie } }],
  ]) {
    const answer=await f.request(path,options);assert.ok(answer.status>=400 && answer.status<500,`${path}:${answer.status}`);
  }
  assert.equal(f.calls.length,0);
  for (const path of ['/start','/callback','/confirmation','/complete']) {
    assert.equal((await f.request(path,{ method: 'DELETE',body: null })).status,405);
  }
  assert.equal(f.calls.length,0);
});

test('invalid callback is scrubbed without service authority; infrastructure and invalid outputs do not masquerade as success',async t=>{
  const f=await fixture(t);
  for (const path of ['/callback?code=bad&state=bad',
    `/callback?state=${f.start.state}&code=${f.code.code}&tenantId=foreign`,
    `/callback?state=${f.start.state}&state=${f.start.state}&code=${f.code.code}`]) {
    const answer=await f.request(path,{ method: 'GET',body: null,headers: { cookie: f.originalCookie } });
    assert.equal(answer.status,303);assert.equal(answer.headers.location,'/?auth=authentication_failed');
  }
  assert.equal(f.calls.length,0);
  f.state.start={ status: 'limited' };assert.equal((await f.request()).status,429);
  f.state.start={ status: 'capacity' };assert.equal((await f.request()).status,503);
  f.state.start=new Error('SQL private provider credential');const failed=await f.request();assert.equal(failed.status,500);
  assert.doesNotMatch(failed.text,/private|provider|credential|SQL/);
  f.state.complete={ ...f.state.complete,setCookie: `${f.ordinaryCookie}; Domain=foreign.test` };
  const invalid=await f.request('/complete',{ headers: { cookie: `${f.originalCookie}; ${f.completionCookie}`,
    'x-csrf-token': f.signed.csrfToken } });assert.equal(invalid.status,500);assert.equal(invalid.headers['set-cookie'],undefined);
  assert.doesNotMatch(f.logs.join(''),/SQL private provider credential/);
});

test('handoff transport remains unavailable without explicit route injection',async t=>{
  const f=await fixture(t,{ injected: false });assert.equal((await f.request()).status,404);assert.equal(f.calls.length,0);
});


test('native Customer start/complete forms keep top-level redirects and require exact final flow CSRF',async t=>{
  const f=await fixture(t),headers={ 'content-type': 'application/x-www-form-urlencoded' };
  const started=await f.request('/start',{ body: '',headers });assert.equal(started.status,303);
  assert.equal(new URL(started.headers.location).origin,f.scope.platformOrigin);
  const cookie=`${f.originalCookie}; ${f.completionCookie}; ${f.ordinaryCookie.split(';')[0]}`;
  const body=new URLSearchParams({ csrfToken: f.signed.csrfToken }).toString();
  for (const value of ['',body+'&csrfToken='+f.signed.csrfToken,'tenantId='+f.flowId]) {
    const denied=await f.request('/complete',{ body: value,headers: { ...headers,cookie } });assert.equal(denied.status,400);
  }
  assert.equal(f.calls.length,1);
  assert.equal((await f.request('/complete',{ body,headers: { ...headers,cookie,'x-csrf-token': f.signed.csrfToken } })).status,400);
  const answer=await f.request('/complete',{ body,headers: { ...headers,cookie } });
  assert.equal(answer.status,303);assert.equal(answer.headers.location,'/');assert.equal(answer.headers['set-cookie'][0],f.ordinaryCookie);
  assert.equal(f.calls.at(-1).input.csrfToken,f.signed.csrfToken);assert.equal(f.calls.at(-1).input.request.headers.cookie,cookie);
});


test('flow-bound explicit logout clears only the actual ordinary cookie after commit and never completes or silently switches',async t=>{
  const f=await fixture(t),cookie=`${f.originalCookie}; ${f.completionCookie}; cm_session=invalid`;
  const view=await f.request('/confirmation',{ method: 'GET',body: null,headers: { cookie } });
  assert.equal(JSON.parse(view.text).accountSwitchRequired,true);
  for (const headers of [{ cookie },{ cookie,'x-csrf-token': 'invalid' },
    { cookie,'x-csrf-token': f.signed.csrfToken,origin: 'https://foreign.test' }]) {
    const denied=await f.request('/logout',{ headers });assert.equal(denied.status,403);
  }
  assert.equal(f.calls.some(call=>call.name==='logout'),false);
  const answer=await f.request('/logout',{ headers: { cookie,'x-csrf-token': f.signed.csrfToken } });
  assert.equal(answer.status,204);assert.deepEqual(answer.headers['set-cookie'],[serializeClearedSessionCookie({ secure: true })]);
  assert.equal(f.calls.at(-1).input.request.headers.cookie,cookie);assert.equal(f.calls.some(call=>call.name==='complete'),false);
  f.state.logout=new Error('COMMIT_FAILED private');
  const failed=await f.request('/logout',{ headers: { cookie,'x-csrf-token': f.signed.csrfToken } });
  assert.equal(failed.status,500);assert.equal(failed.headers['set-cookie'],undefined);assert.doesNotMatch(failed.text,/private|COMMIT/);
});
