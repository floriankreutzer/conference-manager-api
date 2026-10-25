import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { platformHandoffHttpFixture as fixture } from './support/platform-handoff-http-fixture.js';

const STATE=Buffer.alloc(32,1).toString('base64url');
const NONCE=Buffer.alloc(32,2).toString('base64url'),CSRF=Buffer.alloc(32,3).toString('base64url');
const PASSKEY_STATE=Buffer.alloc(32,5).toString('base64url');

test('cross-site Ops arrival preserves only signed intent without an MFA cookie or any protocol call',async t=>{
  const f=await fixture(t);
  const arrival=await f.request(`/arrive?flow=${f.flowId}&state=${STATE}`,{ headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(arrival.status,303);assert.equal(arrival.headers.location,'/?auth=synthetic_intent');
  assert.match(arrival.headers['set-cookie'][0],/SameSite=Strict; Secure; Max-Age=600$/);assert.equal(f.calls.length,0);
  assert.equal((await f.request('/intent',{ headers: { cookie: f.intentCookie } })).status,401);
  const view=await f.request('/intent',{ headers: f.managed });assert.equal(view.status,200);
  assert.deepEqual(Object.keys(JSON.parse(view.text)).sort(),['requestId','roles','slots','status']);
  assert.doesNotMatch(view.text,new RegExp(`${f.flowId}|${STATE}|${f.principal.operatorId}`));
  assert.doesNotMatch(f.logs.join(''),new RegExp(`${f.flowId}|${STATE}|${f.principal.operatorId}`));
});

test('options and final approval derive owner from current principal and release redirect/future MFA only after protocol commit',async t=>{
  const f=await fixture(t),selection={ generationId: f.generationId,slot: 'northwind',role: 'employee' };
  const options=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed });assert.equal(options.status,200);
  assert.equal(f.calls[0].input.intent.operatorId,f.principal.operatorId);assert.equal(f.calls[0].input.intent.flowId,f.flowId);
  assert.equal(f.calls[0].input.intent.state,STATE);assert.match(options.headers['set-cookie'][0],/^cm_platform_operation_tx=/);
  let release,entered,settled=false;f.state.block=new Promise(resolve=>{ release=resolve; });
  const seen=new Promise(resolve=>{ entered=resolve; });f.state.entered=entered;
  const pending=f.request('/approve',{ method: 'POST',body: { ...selection,state: PASSKEY_STATE,response: { synthetic: true } },
    headers: { ...f.managed,cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][0].split(';')[0]}` } })
    .then(result=>{ settled=true;return result; });
  await seen;assert.equal(settled,false);release();const approval=await pending;
  assert.equal(approval.status,303);assert.equal(approval.headers.location,f.state.approve.result.location);assert.equal(approval.text,'');
  assert.equal(approval.headers['set-cookie'][0],f.normalCookie);assert.equal(approval.headers['set-cookie'].length,4);
  assert.equal(f.calls.at(-1).input.cookie,`${PASSKEY_STATE}.${NONCE}`);
  assert.equal(f.calls.at(-1).input.state,PASSKEY_STATE);assert.equal(f.calls.at(-1).input.intent.state,STATE);
  assert.doesNotMatch(f.logs.join(''),new RegExp(`${STATE}|${NONCE}|${CSRF}|${f.flowId}`));
});

test('foreign origin/owner authority, absent normal MFA, unknown selection and missing exact-proof cookie fail closed',async t=>{
  const f=await fixture(t),selection={ generationId: f.generationId,slot: 'northwind',role: 'employee' };
  for (const change of [{ headers: { ...f.managed,origin: 'https://foreign.test' } },
    { headers: { ...f.managed,'sec-fetch-site': 'cross-site' } },{ body: { ...selection,operatorId: randomUUID() } },
    { body: { ...selection,tenantId: randomUUID() } },{ body: { ...selection,role: 'platform_security_admin' } },
    { body: { ...selection,slot: 'foreign' } },{ headers: { cookie: f.managed.cookie } }]) {
    const answer=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed,...change });
    assert.ok(answer.status>=400 && answer.status<500);
  }
  assert.equal(f.calls.length,0);
  assert.equal((await f.request('/approve',{ method: 'POST',body: { ...selection,state: PASSKEY_STATE,response: {} },
    headers: f.managed })).status,403);
  assert.equal(f.calls.length,0);
  f.state.current={ ...f.principal,assurance: { ...f.principal.assurance,authenticationContext: 'conditional-access' } };
  assert.equal((await f.request('/intent',{ headers: f.managed })).status,403);assert.equal(f.calls.length,0);
});

test('unsafe redirect and failed commit cannot emit a Customer code or a normal Platform cookie',async t=>{
  const f=await fixture(t),selection={ generationId: f.generationId,slot: 'northwind',role: 'employee' };
  const options=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed });
  const headers={ ...f.managed,cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][0].split(';')[0]}` };
  for (const value of [new Error('COMMIT_FAILED private-key-material'),
    { ...f.state.approve,principal: f.principal },
    { ...f.state.approve,result: { status: 'redirect',location: `https://foreign.test/?state=${STATE}&code=${NONCE}` } }]) {
    f.state.approve=value;
    const answer=await f.request('/approve',{ method: 'POST',body: { ...selection,state: PASSKEY_STATE,response: {} },headers });
    assert.equal(answer.status,500);assert.equal(answer.headers['set-cookie'],undefined);assert.equal(answer.headers.location,undefined);
    assert.doesNotMatch(answer.text,/private-key|COMMIT|foreign/);
  }
  assert.doesNotMatch(f.logs.join(''),/private-key-material/);
});


test('known custody denial and deployment fences stay closed with bounded403/503, while programming faults remain500',async t=>{
  const f=await fixture(t),selection={ generationId: f.generationId,slot: 'northwind',role: 'employee' };
  const options=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed });
  const headers={ ...f.managed,cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][0].split(';')[0]}` };
  for (const [error,status] of [[new Error('SYNTHETIC_HANDOFF_DENIED'),403],
    [new Error('SYNTHETIC_HANDOFF_OWNER_CAPACITY'),503],
    [Object.assign(new Error('private fence'),{ code: 'PROTECTED_RUNTIME_BUSY' }),503],
    [Object.assign(new Error('private stale'),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' }),503],
    [Object.assign(new Error('private order'),{ code: 'PROTECTED_RUNTIME_GATE_ORDER_INVALID' }),500]]) {
    for (const route of ['options','approve']) {
      f.state[route]=error;
      const answer=await f.request(`/${route}`,{ method: 'POST',body: route==='options' ? selection
        : { ...selection,state: PASSKEY_STATE,response: {} },headers });
      assert.equal(answer.status,status);assert.equal(answer.headers['set-cookie'],undefined);
      assert.equal(answer.headers.location,undefined);assert.doesNotMatch(answer.text,/private|SYNTHETIC_HANDOFF|RUNTIME/);
    }
  }
  assert.doesNotMatch(f.logs.join(''),/private fence|private stale|private order/);
});


test('native approval form preserves top-level303 and verifies its own session CSRF without accepting header/body ambiguity',async t=>{
  const f=await fixture(t),selection={ generationId: f.generationId,slot: 'northwind',role: 'employee' };
  const options=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed });
  const headers={ ...f.managed,'content-type': 'application/x-www-form-urlencoded','x-csrf-token': undefined,
    cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][0].split(';')[0]}` };
  const payload=JSON.stringify({ ...selection,state: PASSKEY_STATE,response: {} });
  const body=new URLSearchParams({ csrfToken: CSRF,payload }).toString();
  for (const invalid of [new URLSearchParams({ csrfToken: NONCE,payload }).toString(),body+'&csrfToken='+CSRF,
    new URLSearchParams({ csrfToken: CSRF,payload,operatorId: f.principal.operatorId }).toString()]) {
    const rejected=await f.request('/approve',{ method: 'POST',body: invalid,headers });
    assert.ok(rejected.status>=400 && rejected.status<500);
  }
  assert.equal(f.calls.length,1);
  assert.equal((await f.request('/approve',{ method: 'POST',body,headers: { ...headers,'x-csrf-token': CSRF } })).status,400);
  const answer=await f.request('/approve',{ method: 'POST',body,headers });
  assert.equal(answer.status,303);assert.equal(answer.headers.location,f.state.approve.result.location);assert.equal(answer.text,'');
  assert.equal(answer.headers['set-cookie'][0],f.normalCookie);assert.equal(f.calls.length,2);
  assert.equal(f.calls.at(-1).input.intent.operatorId,f.principal.operatorId);
  assert.doesNotMatch(f.logs.join(''),new RegExp(`${CSRF}|${PASSKEY_STATE}|${STATE}`));
});


test('normal MFA startup can check for a pending intent after login without creating any grant or resetting a generation',async t=>{
  const f=await fixture(t),headers={ cookie: f.normalCookie.split(';')[0] };
  for (const cookie of [headers.cookie,`${headers.cookie}; cm_synthetic_intent=invalid`]) {
    const result=await f.request('/intent',{ headers: { cookie } });assert.equal(result.status,200);
    assert.deepEqual(Object.keys(JSON.parse(result.text)).sort(),['requestId','status']);
    assert.equal(JSON.parse(result.text).status,'none');assert.equal(result.headers['set-cookie'],undefined);
  }
  assert.equal(f.calls.length,0);
  assert.equal((await f.request('/intent')).status,401);
  assert.equal((await f.request('/options',{ method: 'POST',headers: { ...headers,'x-csrf-token': CSRF },
    body: { generationId: f.generationId,slot: 'northwind',role: 'employee' } })).status,403);
  assert.equal(f.calls.length,0);
});
