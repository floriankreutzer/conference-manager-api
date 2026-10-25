import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { platformHandoffHttpFixture } from './support/platform-handoff-http-fixture.js';

const fixture=t=>platformHandoffHttpFixture(t,{ kind: 'owner_real' });

test('Owner arrival retains separate intent; the directory requires normal Microsoft and original intent',async t=>{
  const f=await fixture(t);
  const arrival=await f.request(`/arrive?flow=${f.flowId}&state=${f.STATE}`,{ headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(arrival.status,303);assert.equal(arrival.headers.location,'/?auth=owner_intent');
  assert.match(arrival.headers['set-cookie'][0],/^cm_platform_owner_intent=.*Path=\/api\/v1\/platform\/auth\/owner; /);
  assert.equal(f.calls.length,0);assert.equal((await f.request('/intent',{ headers: { cookie: f.intentCookie } })).status,401);
  const view=await f.request('/intent',{ headers: f.managed });assert.equal(view.status,200);
  const dto=JSON.parse(view.text);
  assert.deepEqual(Object.keys(dto).sort(),['customerStartUrl','nextTenantId','requestId','roles','status','tenants']);
  assert.deepEqual(dto.tenants,f.state.directory.tenants);assert.equal(dto.status,'confirmation_required');
  assert.equal(f.calls[0].name,'directory');assert.equal(f.calls[0].input.principal.operatorId,f.principal.operatorId);
  assert.equal(f.calls[0].input.afterTenantId,null);
  const after=randomUUID(),next=await f.request(`/intent?afterTenantId=${after}`,{ headers: f.managed });
  assert.equal(next.status,200);assert.equal(f.calls.at(-1).input.afterTenantId,after);
  const noIntent=await f.request('/intent',{ headers: { cookie: f.normalCookie.split(';')[0] } });
  assert.equal(noIntent.status,200);assert.equal(JSON.parse(noIntent.text).status,'none');
  assert.equal(JSON.parse(noIntent.text).customerStartUrl,f.scope.customerOrigin+'/?auth=owner_start');
  assert.doesNotMatch(view.text,new RegExp(`${f.flowId}|${f.STATE}|${f.principal.operatorId}`));
  assert.doesNotMatch(f.logs.join(''),new RegExp(`${f.flowId}|${f.STATE}|${f.principal.operatorId}`));
});

test('REAL owner exact Microsoft options and native final approval preserve selection and never supply credential response',async t=>{
  const f=await fixture(t),selection={ tenantId: f.generationId,role: 'tenant_admin' };
  const options=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed });assert.equal(options.status,200);
  assert.equal(JSON.parse(options.text).status,'microsoft_required');assert.equal(options.headers['set-cookie'].length,2);
  assert.equal(new URL(JSON.parse(options.text).authorizationUrl).searchParams.get('prompt'),'login');
  const input=f.calls.at(-1).input;assert.deepEqual(Object.keys(input.intent).sort(),['flowId','operatorId','role','state','tenantId']);
  assert.equal(input.intent.operatorId,f.principal.operatorId);assert.equal(input.intent.tenantId,f.generationId);
  assert.equal(input.intent.flowId,f.flowId);assert.equal(input.intent.state,f.STATE);
  const headers={ ...f.managed,'content-type': 'application/x-www-form-urlencoded','x-csrf-token': undefined,
    cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][1].split(';')[0]}` };
  const body=new URLSearchParams({ csrfToken: f.CSRF,payload: JSON.stringify({ ...selection,state: f.operationState }) }).toString();
  let release,entered,settled=false;f.state.block=new Promise(resolve=>{ release=resolve; });
  const seen=new Promise(resolve=>{ entered=resolve; });f.state.entered=entered;
  const pending=f.request('/approve',{ method: 'POST',body,headers }).then(result=>{ settled=true;return result; });
  await seen;assert.equal(settled,false);release();const completed=await pending;
  assert.equal(completed.status,303);assert.equal(completed.headers.location,f.state.approve.result.location);
  assert.equal(completed.headers['set-cookie'][0],f.normalCookie);assert.equal(completed.headers['set-cookie'].length,4);
  assert.equal(Object.hasOwn(f.calls.at(-1).input,'response'),false);
  assert.equal(f.calls.at(-1).input.cookie,`${f.operationState}.${f.NONCE}`);
  assert.equal(f.calls.at(-1).input.intent.state,f.STATE);assert.equal(f.calls.at(-1).input.state,f.operationState);
});

test('Owner HTTP denies synthetic/identity authority, missing proof, cross-protocol cookies and foreign origins',async t=>{
  const f=await fixture(t),selection={ tenantId: f.generationId,role: 'employee' };
  for (const change of [{ body: { ...selection,userId: randomUUID() } },{ body: { ...selection,operatorId: randomUUID() } },
    { body: { ...selection,generationId: f.generationId } },{ body: { ...selection,slot: 'northwind' } },
    { body: { ...selection,response: {} } },{ body: { ...selection,role: 'platform_security_admin' } },
    { headers: { ...f.managed,origin: 'https://foreign.test' } },{ headers: { ...f.managed,'sec-fetch-site': 'cross-site' } },
    { headers: { ...f.managed,cookie: f.managed.cookie.replace('cm_platform_owner_intent','cm_platform_synthetic_intent') } }]) {
    const answer=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed,...change });
    assert.ok(answer.status>=400 && answer.status<500);
  }
  assert.equal(f.calls.length,0);
  const invalid=await f.request('/approve',{ method: 'POST',headers: f.managed,body: { ...selection,state: f.operationState } });
  assert.equal(invalid.status,403);assert.equal(f.calls.length,0);
  for (const query of ['?afterTenantId=wrong',`?afterTenantId=${f.flowId}&afterTenantId=${f.flowId}`,'?tenantId=foreign']) {
    assert.equal((await f.request('/intent'+query,{ headers: f.managed })).status,400);
  }
  f.state.current={ ...f.principal,assurance: { ...f.principal.assurance,authenticationContext: 'cm:pk:v1' } };
  assert.equal((await f.request('/intent',{ headers: f.managed })).status,403);assert.equal(f.calls.length,0);
});

test('failed owner commit, private current-custody denial and unsafe redirects release no continuation cookie or Customer code',async t=>{
  const f=await fixture(t),selection={ tenantId: f.generationId,role: 'employee' };
  const options=await f.request('/options',{ method: 'POST',body: selection,headers: f.managed });
  const headers={ ...f.managed,cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][1].split(';')[0]}` };
  const approved=f.state.approve;
  for (const [result,status] of [[new Error('COMMIT_FAILED private'),500],[new Error('OWNER_HANDOFF_DENIED'),403],
    [new Error('OWNER_HANDOFF_CAPACITY'),503],[{ ...approved,principal: f.principal },500],
    [{ ...approved,result: { status: 'redirect',location: approved.result.location.replace('/owner/','/delegation/') } },500]]) {
    f.state.approve=result;
    const answer=await f.request('/approve',{ method: 'POST',body: { ...selection,state: f.operationState },headers });
    assert.equal(answer.status,status);assert.equal(answer.headers['set-cookie'],undefined);assert.equal(answer.headers.location,undefined);
    assert.doesNotMatch(answer.text,/private|COMMIT|OWNER_HANDOFF/);
  }
  assert.doesNotMatch(f.logs.join(''),/COMMIT_FAILED private/);
});
