import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { createPlatformLogger } from '../src/platform/http/observability.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { readPlatformSessionToken,serializePlatformSessionCookie } from '../src/platform/identity/session-cookie.js';
import { serializePlatformPasskeyTransactionCookie,clearPlatformPasskeyTransactionCookie }
  from '../src/platform/identity/passkey-auth-cookie.js';
import { createPlatformSyntheticHandoffIntentCookie } from '../src/platform/identity/synthetic-handoff-intent-cookie.js';
import { createPlatformSyntheticHandoffRouteModule } from '../src/platform/http/synthetic-handoff-routes.js';

const ROOT='/api/v1/platform/auth/delegation',ORIGIN='https://localhost',STATE=Buffer.alloc(32,1).toString('base64url');
const NONCE=Buffer.alloc(32,2).toString('base64url'),CSRF=Buffer.alloc(32,3).toString('base64url');
const PASSKEY_STATE=Buffer.alloc(32,5).toString('base64url');
async function fixture(t,{ injected=true }={}) {
  const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
    customerOrigin: 'https://127.0.0.1',platformOrigin: ORIGIN },operatorId=randomUUID(),flowId=randomUUID();
  const roles=['platform_tenant_operator'],now=new Date().toISOString(),sessionId=randomUUID(),generationId=randomUUID();
  const principal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
    providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: 'directory',subjectReference: 'subject' },
    targetScope: { mode: 'allowlist',securityVersion: 3 },
    assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: now },
    session: { id: sessionId,issuedAt: now,expiresAt: new Date(Date.now()+3_600_000).toISOString(),securityVersion: 3,
      securityEpoch: 7,stepUpExpiresAt: null } };
  const token=Buffer.alloc(32,4).toString('base64url');
  const normalCookie=serializePlatformSessionCookie(token,{ secure: true,maxAgeSeconds: 3600 });
  const cookieCodec=createPlatformSyntheticHandoffIntentCookie({ scope,secret: 'i'.repeat(48) });
  const intentCookie=cookieCodec.issue({ flowId,state: STATE }).split(';')[0],calls=[],logs=[];
  const state={ current: principal,block: null,entered: null,
    options: { status: 'passkey_required',state: PASSKEY_STATE,options: { challenge: NONCE,userVerification: 'required' },
      setCookie: serializePlatformPasskeyTransactionCookie(`${PASSKEY_STATE}.${NONCE}`) },
    approve: { status: 'operation_completed',principal: { ...principal,session: { ...principal.session,id: randomUUID() } },
      csrfToken: CSRF,setCookies: [normalCookie,clearPlatformPasskeyTransactionCookie()],
      result: { status: 'redirect',location: `${scope.customerOrigin}/api/v1/auth/delegation/callback?state=${STATE}&code=${NONCE}` } } };
  const protocol=Object.fromEntries(['options','approve'].map(name=>[name,async input=>{
    calls.push({ name,input });if (name==='approve' && state.block) { state.entered();await state.block; }
    if (state[name] instanceof Error) throw state[name];return state[name];
  }]));
  const module=createPlatformSyntheticHandoffRouteModule({ protocol,intentCookie: cookieCodec,scope });
  const config={ mode: 'test',serviceVersion: '0.1.0',buildId: 'test-build',publicOrigin: ORIGIN,
    entraAuthority: `https://login.microsoftonline.com/${operatorId}`,entraClientId: sessionId,
    entraRedirectUri: `${ORIGIN}/api/v1/platform/auth/microsoft/callback`,mfaAuthenticationContext: 'c1',
    stepUpAuthenticationContext: 'c2',authenticationMaxAgeSeconds: 900,maxBodyBytes: 32768,maxResponseBytes: 65536,
    rateLimitMax: 1000,rateLimitWindowMs: 60000,rateLimitMaxKeys: 100,requestTimeoutMs: 5000,headersTimeoutMs: 5000,
    keepAliveTimeoutMs: 1000 };
  const server=createPlatformHttpServer({ config,routeModules: injected ? [module] : [],
    logger: createPlatformLogger({ write: v=>logs.push(v) }),
    platformSessionService: { resolvePrincipal: async request=>readPlatformSessionToken(request.headers)===token ? state.current : null,
      verifyCsrf: async request=>request.headers['x-csrf-token']===CSRF },
    platformAuditService: { createUnmappedAuthenticationFailure: value=>value,createDeniedEvent: value=>value,async record() {} } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ cookieCodec.destroy();await new Promise(resolve=>server.close(resolve)); });
  async function request(path,{ method='GET',body,headers={} }={}) {
    const raw=body===undefined ? null : JSON.stringify(body);
    return new Promise((resolve,reject)=>{
      const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path: ROOT+path,method,
        headers: Object.fromEntries(Object.entries({ host: 'localhost',...(method==='POST' ? { origin: ORIGIN } : {}),
          ...(raw===null ? {} : { 'content-type': 'application/json','content-length': Buffer.byteLength(raw) }),...headers })
          .filter(([,value])=>value!==undefined)) },res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({ status: res.statusCode,
          headers: res.headers,text: Buffer.concat(chunks).toString('utf8') }));
      });req.on('error',reject);if (raw) req.write(raw);req.end();
    });
  }
  const managed={ cookie: `${normalCookie.split(';')[0]}; ${intentCookie}`,'x-csrf-token': CSRF,'sec-fetch-site': 'same-origin' };
  return { request,state,calls,logs,flowId,generationId,principal,normalCookie,intentCookie,managed,scope };
}

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
