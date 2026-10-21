import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { createPlatformLogger } from '../src/platform/http/observability.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { serializePlatformSessionCookie,readPlatformSessionToken } from '../src/platform/identity/session-cookie.js';
import { serializePlatformPasskeyTransactionCookie,clearPlatformPasskeyTransactionCookie }
  from '../src/platform/identity/passkey-auth-cookie.js';
import { createPlatformSyntheticGenerationRouteModule } from '../src/platform/http/synthetic-generation-routes.js';

const ROOT='/api/v1/platform/synthetic/generation',ORIGIN='https://localhost';
const opaque=value=>Buffer.alloc(32,value).toString('base64url'),STATE=opaque(1),NONCE=opaque(2),CSRF=opaque(3),TOKEN=opaque(4);
async function fixture(t) {
  const now=new Date().toISOString(),operatorId=randomUUID(),generationId=randomUUID(),roles=['platform_tenant_operator'];
  const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,platformOrigin: ORIGIN };
  const principal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
    providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: 'directory',subjectReference: 'subject' },
    targetScope: { mode: 'allowlist',securityVersion: 3 },
    assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: now },
    session: { id: randomUUID(),issuedAt: now,expiresAt: new Date(Date.now()+3_600_000).toISOString(),
      securityVersion: 3,securityEpoch: 7,stepUpExpiresAt: null } };
  const currentCookie=serializePlatformSessionCookie(TOKEN,{ secure: true,maxAgeSeconds: 3600 });
  const normalCookie=serializePlatformSessionCookie(opaque(5),{ secure: true,maxAgeSeconds: 3600 });
  const generation={ generationId,revision: 2,tenants: ['northwind','contoso','fabrikam'].map((slot,index)=>({ slot,
    tenantId: randomUUID(),displayName: slot,status: ['active','ready','onboarding'][index] })) };
  const state={ current: { generation: null,retainedGenerations: 0,canReplace: true,replaceAfter: null },principal,
    options: { status: 'passkey_required',state: STATE,options: { challenge: NONCE,userVerification: 'required' },
      setCookie: serializePlatformPasskeyTransactionCookie(`${STATE}.${NONCE}`) },
    replace: { status: 'operation_completed',principal: { ...principal,session: { ...principal.session,id: randomUUID() } },
      csrfToken: CSRF,setCookies: [normalCookie,clearPlatformPasskeyTransactionCookie()],result: generation },block: null,entered: null };
  const calls=[],logs=[];
  const protocol=Object.fromEntries(['current','options','replace'].map(name=>[name,async input=>{
    calls.push({ name,input });if (name==='replace' && state.block) { state.entered();await state.block; }
    if (state[name] instanceof Error) throw state[name];return state[name];
  }]));
  const module=createPlatformSyntheticGenerationRouteModule({ protocol,scope });
  const config={ mode: 'test',serviceVersion: '0.1.0',buildId: 'test',publicOrigin: ORIGIN,
    entraAuthority: `https://login.microsoftonline.com/${operatorId}`,entraClientId: randomUUID(),
    entraRedirectUri: `${ORIGIN}/api/v1/platform/auth/microsoft/callback`,mfaAuthenticationContext: 'c1',stepUpAuthenticationContext: 'c2',
    authenticationMaxAgeSeconds: 900,maxBodyBytes: 32768,maxResponseBytes: 65536,rateLimitMax: 1000,rateLimitWindowMs: 60000,
    rateLimitMaxKeys: 100,requestTimeoutMs: 5000,headersTimeoutMs: 5000,keepAliveTimeoutMs: 1000 };
  const server=createPlatformHttpServer({ config,routeModules: [module],logger: createPlatformLogger({ write: line=>logs.push(line) }),
    platformSessionService: { resolvePrincipal: async request=>readPlatformSessionToken(request.headers)===TOKEN ? state.principal : null,
      verifyCsrf: async request=>request.headers['x-csrf-token']===CSRF },
    platformAuditService: { createUnmappedAuthenticationFailure: value=>value,createDeniedEvent: value=>value,async record() {} } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  async function request(path='',{ method='GET',body,headers={} }={}) {
    const raw=body===undefined ? null : JSON.stringify(body);
    return new Promise((resolve,reject)=>{
      const outgoing=http.request({ hostname: '127.0.0.1',port: server.address().port,path: ROOT+path,method,
        headers: { host: 'localhost',...(method==='POST' ? { origin: ORIGIN,'sec-fetch-site': 'same-origin' } : {}),
          ...(raw===null ? {} : { 'content-type': 'application/json','content-length': Buffer.byteLength(raw) }),...headers } },incoming=>{
        const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>resolve({ status: incoming.statusCode,
          headers: incoming.headers,text: Buffer.concat(chunks).toString('utf8') }));
      });outgoing.on('error',reject);outgoing.end(raw);
    });
  }
  const managed={ cookie: currentCookie.split(';')[0],'x-csrf-token': CSRF };
  return { state,calls,logs,principal,normalCookie,generation,request,managed };
}

test('own metadata is minimized and exact create/reset binds only server-derived operator and expected generation',async t=>{
  const f=await fixture(t);assert.equal((await f.request()).status,401);assert.equal(f.calls.length,0);
  const view=await f.request('',{ headers: f.managed });assert.equal(view.status,200);
  assert.deepEqual(Object.keys(JSON.parse(view.text)).sort(),['canReplace','generation','replaceAfter','requestId','retainedGenerations']);
  const intent={ expectedGenerationId: null,expectedRevision: 0 };
  const options=await f.request('/options',{ method: 'POST',body: intent,headers: f.managed });assert.equal(options.status,200);
  assert.equal(f.calls.at(-1).input.intent.operatorId,f.principal.operatorId);
  let release,entered,settled=false;f.state.block=new Promise(resolve=>{ release=resolve; });
  const seen=new Promise(resolve=>{ entered=resolve; });f.state.entered=entered;
  const pending=f.request('/replace',{ method: 'POST',body: { ...intent,state: STATE,response: {} },
    headers: { ...f.managed,cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][0].split(';')[0]}` } })
    .then(answer=>{ settled=true;return answer; });
  await seen;assert.equal(settled,false);release();const answer=await pending;assert.equal(answer.status,200);
  assert.equal(answer.headers['set-cookie'][0],f.normalCookie);
  const payload=JSON.parse(answer.text);assert.equal(payload.status,'generation_replaced');
  assert.equal(payload.generation.generationId,f.generation.generationId);assert.equal(payload.csrfToken,CSRF);
  assert.equal(payload.generation.tenants.some(tenant=>Object.hasOwn(tenant,'displayName')),false);
  assert.doesNotMatch(answer.text,new RegExp(f.principal.operatorId));
  assert.doesNotMatch(f.logs.join(''),new RegExp(`${CSRF}|${STATE}|${NONCE}|${f.principal.operatorId}`));
});

test('foreign origin/owner/tenant/query, inconsistent revisions and absent exact proof cannot call generation mutation',async t=>{
  const f=await fixture(t),intent={ expectedGenerationId: null,expectedRevision: 0 };
  for (const [path,options] of [
    ['/options',{ body: { ...intent,operatorId: randomUUID() } }],['/options',{ body: { ...intent,tenantId: randomUUID() } }],
    ['/options',{ body: { ...intent,expectedRevision: 2 } }],['/options?operatorId=foreign',{ body: intent }],
    ['/options',{ body: intent,headers: { ...f.managed,origin: 'https://foreign.test' } }],
    ['/options',{ body: intent,headers: { cookie: f.managed.cookie } }],
    ['/replace',{ body: { ...intent,state: STATE,response: {} } }],
  ]) {
    const answer=await f.request(path,{ method: 'POST',headers: f.managed,...options });
    assert.ok(answer.status>=400 && answer.status<500);
  }
  assert.equal(f.calls.length,0);
  f.state.principal={ ...f.principal,assurance: { ...f.principal.assurance,authenticationContext: 'conditional-access' } };
  assert.equal((await f.request('',{ headers: f.managed })).status,403);assert.equal(f.calls.length,0);
});

test('commit/result failures cannot emit a normal cookie and known conflicts keep bounded HTTP semantics',async t=>{
  const f=await fixture(t),intent={ expectedGenerationId: null,expectedRevision: 0 };
  const options=await f.request('/options',{ method: 'POST',body: intent,headers: f.managed });
  const headers={ ...f.managed,cookie: `${f.managed.cookie}; ${options.headers['set-cookie'][0].split(';')[0]}` };
  for (const value of [new Error('COMMIT_FAILED private'),{ ...f.state.replace,principal: f.principal },
    { ...f.state.replace,csrfToken: 'invalid' },{ ...f.state.replace,result: { ...f.generation,operatorId: f.principal.operatorId } },
    { ...f.state.replace,result: { ...f.generation,tenants: f.generation.tenants.slice(0,2) } }]) {
    f.state.replace=value;
    const answer=await f.request('/replace',{ method: 'POST',body: { ...intent,state: STATE,response: {} },headers });
    assert.equal(answer.status,500);assert.equal(answer.headers['set-cookie'],undefined);assert.doesNotMatch(answer.text,/private|COMMIT/);
  }
  for (const code of ['SYNTHETIC_GENERATION_STALE','SYNTHETIC_GENERATION_COOLDOWN','SYNTHETIC_GENERATION_RETENTION_LIMIT']) {
    f.state.options=new Error(code);
    const answer=await f.request('/options',{ method: 'POST',body: intent,headers: f.managed });
    assert.equal(answer.status,409);assert.equal(answer.headers['set-cookie'],undefined);
  }
  assert.doesNotMatch(f.logs.join(''),/COMMIT_FAILED|private/);
});
