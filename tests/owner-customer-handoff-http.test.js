import assert from 'node:assert/strict';
import test from 'node:test';
import { customerHandoffHttpFixture } from './support/customer-handoff-http-fixture.js';

const fixture=t=>customerHandoffHttpFixture(t,{ kind: 'owner_real' });

test('REAL owner callback retains separate original-browser custody and reveals only the approved confirmation',async t=>{
  const f=await fixture(t),started=await f.request();
  assert.equal(started.status,303);
  const location=new URL(started.headers.location);
  assert.equal(location.origin,f.scope.platformOrigin);assert.equal(location.pathname,'/api/v1/platform/auth/owner/arrive');
  assert.equal(location.searchParams.get('flow'),f.flowId);assert.equal(location.searchParams.get('state'),f.start.state);
  assert.match(started.headers['set-cookie'][0],
    /^cm_owner_browser=.*Path=\/api\/v1\/auth\/owner; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
  assert.doesNotMatch(started.headers['set-cookie'].join(';'),/cm_session=|cm_synthetic_|Domain=/);
  const callback=await f.request(`/callback?state=${f.start.state}&code=${f.code.code}`,{ method: 'GET',body: null,
    headers: { cookie: f.originalCookie,origin: undefined,'sec-fetch-site': 'cross-site' } });
  assert.equal(callback.status,303);assert.equal(callback.headers.location,'/?auth=owner_confirmation');
  assert.match(callback.headers['set-cookie'][0],/^cm_owner_completion=.*SameSite=Strict; Secure; Max-Age=30$/);
  assert.doesNotMatch(callback.headers['set-cookie'].join(';'),/cm_session=/);
  const view=await f.request('/confirmation',{ method: 'GET',body: null,
    headers: { cookie: `${f.originalCookie}; ${f.completionCookie}` } });
  assert.equal(view.status,200);const result=JSON.parse(view.text);
  assert.deepEqual(Object.keys(result).sort(),['accountSwitchRequired','csrfToken','requestId','role','tenantId','tenantName']);
  assert.equal(result.tenantId,f.tenantId);assert.equal(result.tenantName,'Owner test Customer');
  assert.doesNotMatch(view.text,new RegExp(`${f.flowId}|${f.start.state}|${f.start.browserToken}|${f.code.code}`));
  assert.equal(f.calls.some(call=>call.name==='complete'),false);
});

test('REAL owner transport rejects cross-protocol cookies, caller authority, duplicate callback fields and unsafe origins',async t=>{
  const f=await fixture(t),cookie=`${f.originalCookie}; ${f.completionCookie}`;
  const foreign=cookie.replaceAll('cm_owner_','cm_synthetic_');
  for (const [path,options] of [
    ['/start',{ body: { tenantId: f.tenantId,role: 'tenant_admin' } }],
    ['/start',{ body: { operatorId: f.flowId } }],['/start',{ headers: { origin: 'https://foreign.test' } }],
    ['/start',{ headers: { origin: undefined } }],['/start?role=tenant_admin',{}],
    ['/complete',{ headers: { cookie: foreign,'x-csrf-token': f.signed.csrfToken } }],
    ['/complete',{ headers: { cookie } }],['/complete',{ headers: { cookie,'x-csrf-token': 'wrong' } }],
    ['/confirmation',{ method: 'GET',body: null,headers: { cookie: `${cookie}; ${f.originalCookie}` } }],
  ]) assert.ok((await f.request(path,options)).status>=400,path);
  const duplicate=await f.request(`/callback?state=${f.start.state}&code=${f.code.code}&code=${f.code.code}`,
    { method: 'GET',body: null,headers: { cookie: f.originalCookie } });
  assert.equal(duplicate.status,303);assert.equal(duplicate.headers.location,'/?auth=authentication_failed');
  assert.equal(f.calls.length,0);
});

test('REAL owner final navigation waits for committed private service and retains explicit account-change denial',async t=>{
  const f=await fixture(t);let release,entered,settled=false;
  f.state.block=new Promise(resolve=>{ release=resolve; });
  const seen=new Promise(resolve=>{ entered=resolve; });f.state.entered=entered;
  const cookie=`${f.originalCookie}; ${f.completionCookie}; ${f.ordinaryCookie.split(';')[0]}`;
  const headers={ cookie,'content-type': 'application/x-www-form-urlencoded' };
  const body=new URLSearchParams({ csrfToken: f.signed.csrfToken }).toString();
  const pending=f.request('/complete',{ body,headers }).then(value=>{ settled=true;return value; });
  await seen;assert.equal(settled,false);assert.equal(f.calls.at(-1).input.request.headers.cookie,cookie);
  assert.equal(f.calls.at(-1).input.csrfToken,f.signed.csrfToken);release();
  const result=await pending;assert.equal(result.status,303);assert.equal(result.headers.location,'/');
  assert.equal(result.headers['set-cookie'][0],f.ordinaryCookie);
  assert.equal(result.headers['set-cookie'].filter(value=>/Max-Age=0/.test(value)).length,2);
  assert.doesNotMatch(result.headers['set-cookie'].join(';'),/cm_synthetic_/);
  f.state.block=null;f.state.complete=new Error('OWNER_HANDOFF_LOGOUT_REQUIRED');
  const denied=await f.request('/complete',{ body,headers });assert.equal(denied.status,409);
  assert.match(denied.text,/AUTHENTICATION_LOGOUT_REQUIRED/);assert.equal(denied.headers['set-cookie'],undefined);
  f.state.complete=new Error('COMMIT_FAILED private');
  const failed=await f.request('/complete',{ body,headers });assert.equal(failed.status,500);
  assert.equal(failed.headers['set-cookie'],undefined);assert.doesNotMatch(failed.text,/COMMIT|private/);
});

test('REAL owner confirmation enforces its closed approved target schema and transport requires explicit injection',async t=>{
  const f=await fixture(t),valid=f.state.confirmation,cookie=`${f.originalCookie}; ${f.completionCookie}`;
  for (const changes of [{ slot: 'northwind' },{ tenantId: 'foreign' },{ tenantName: '' },{ tenantName: 'x'.repeat(201) },
    { tenantName: 'unsafe\nname' },{ role: 'platform_security_admin' },{ userId: f.flowId }]) {
    f.state.confirmation={ ...valid,...changes };
    const answer=await f.request('/confirmation',{ method: 'GET',body: null,headers: { cookie } });assert.equal(answer.status,500);
  }
  const absent=await customerHandoffHttpFixture(t,{ kind: 'owner_real',injected: false });
  assert.equal((await absent.request()).status,404);assert.equal(absent.calls.length,0);
});
