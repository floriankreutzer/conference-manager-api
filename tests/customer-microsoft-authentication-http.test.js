import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createCustomerMicrosoftAuthenticationRouteModule } from '../src/http/customer-microsoft-authentication-routes.js';
import { serializeCustomerMicrosoftTransactionCookie } from '../src/identity/customer-microsoft-cookie.js';
import { serializeSessionCookie } from '../src/identity/session-cookie.js';
import { EntraAuthenticationError } from '../src/identity/entra-errors.js';
const ROOT='/api/v1/auth/microsoft',ORIGIN='https://127.0.0.1',STATE='S'.repeat(43),BROWSER='B'.repeat(43),CHOICE='C'.repeat(43);
const id=n=>`b7000000-0000-4000-8000-${String(n).padStart(12,'0')}`,CSRF='c'.repeat(64);
const cookie=verified=>serializeCustomerMicrosoftTransactionCookie({ flowId: id(1),browserToken: verified ? CHOICE : BROWSER },
  { maxAgeSeconds: verified ? 300 : 600,sameSite: verified ? 'Strict' : 'Lax' });
const session=serializeSessionCookie('N'.repeat(43),{ secure: true,maxAgeSeconds: 28800 });
const principal={ tenantId: id(2),userId: id(3),roles: ['employee'],permissions: [],
  providerIdentity: { provider: 'email_code',reference: id(4) },session: { id: id(5),securityVersion: 1,
    issuedAt: '2026-10-20T12:00:00.000Z',expiresAt: '2026-10-20T13:00:00.000Z' } };
async function fixture(t,{ injected=true,composed=false }={}) {
  const calls=[],logs=[],sources=[];
  const state={ principal,startLogin: { status: 'redirect',authorizationUrl:
    `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?state=${STATE}`,setCookie: cookie(false) },
    complete: { status: 'membership_required',csrfToken: CSRF,setCookie: cookie(true) },
    choices: { status: 'membership_required',csrfToken: CSRF,items: [{ membershipId: id(6),displayName: 'Invited organization',
      roles: ['platform_admin'],recipient: 'Private@example.test' }] },select: { status: 'authenticated',setCookie: session },
    accountState: { status: 'account',microsoftLinked: false,emailReauthenticationRequired: false },
    linkConfirmation: { status: 'link_confirmation_required',csrfToken: CSRF },
    confirmLink: { status: 'authenticated',setCookie: session } };
  const port=name=>async(...args)=>{ calls.push({ name,args });const value=state[name==='startLink' ? 'startLogin' : name];
    if (value instanceof Error) throw value;return value; };
  const service={ startLogin: port('startLogin'),startLink: port('startLink'),complete: port('complete') };
  const module=createCustomerMicrosoftAuthenticationRouteModule({ publicOrigin: ORIGIN,authenticationService: service,
    admissionService: Object.fromEntries(['choices','select','linkConfirmation','confirmLink','accountState'].map(name=>[name,port(name)])),
    sourceKey: { fingerprint(address) { sources.push(address);return 'f'.repeat(64); } },
    sessionService: { async resolvePrincipal() { return state.principal; } } });
  const config=loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: ORIGIN,RATE_LIMIT_MAX: '120' });
  const options={ config,logger: createLogger({ write: line=>logs.push(line) }),resolvePrincipal: async()=>state.principal,
    verifyCsrf: async request=>request.headers['x-csrf-token']==='ordinary-session-csrf',
    ...(injected ? { customerMicrosoftAuthenticationRouteModule: module } : {}) };
  const server=composed ? createCustomerComposition({ config,persistence: null,
    additionalRouteModules: injected ? [module] : [],
    httpServerFactory: selected=>createHttpServer({ ...selected,logger: options.logger,
      resolvePrincipal: options.resolvePrincipal,verifyCsrf: options.verifyCsrf }) }).server : createHttpServer(options);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  async function request(path='/login',{ method='GET',body=null,headers={} }={}) {
    const raw=body===null ? null : typeof body==='string' ? body : JSON.stringify(body);
    return new Promise((resolve,reject)=>{
      const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path: `${ROOT}${path}`,method,
        headers: Object.fromEntries(Object.entries({ host: '127.0.0.1',origin: ORIGIN,'sec-fetch-site': 'same-origin',
          ...(raw===null ? {} : { 'content-type': 'application/json','content-length': Buffer.byteLength(raw) }),...headers })
          .filter(([,value])=>value!==undefined)) },res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({ status: res.statusCode,
          headers: res.headers,body: Buffer.concat(chunks).toString('utf8') }));
      });req.on('error',reject);req.end(raw);
    });
  }
  return { calls,state,logs,sources,request,options,module };
}
test('Customer composition routes Microsoft login and callback before inactive legacy authentication',async t=>{
  const f=await fixture(t,{ composed: true }),start=await f.request();
  assert.equal(start.status,302);assert.equal(start.headers.location,f.state.startLogin.authorizationUrl);
  assert.deepEqual(start.headers['set-cookie'],[cookie(false)]);
  const result=await f.request(`/callback?state=${STATE}&code=synthetic-code`,{
    headers: { cookie: cookie(false).split(';')[0],origin: undefined,'sec-fetch-site': 'cross-site' } });
  assert.equal(result.status,303);assert.equal(result.headers.location,'/?auth=microsoft_membership_required');
  assert.deepEqual(f.calls.map(call=>call.name),['startLogin','complete']);
  assert.equal((await f.request('/login',{ headers: { origin: 'https://other.invalid' } })).status,403);
  assert.equal((await f.request('/login?tenantId=untrusted')).status,400);
  assert.equal((await f.request('/login',{ method: 'POST' })).status,405);
  assert.equal(f.calls.length,2);
  assert.equal((await f.request('/link/status')).status,200);
  assert.equal((await f.request('/link/start',{ method: 'POST',body: {} })).status,403);
});
test('Customer composition rejects duplicate Microsoft modules and closed Demo injection, and preserves inactive login',async t=>{
  const f=await fixture(t,{ composed: true,injected: false });
  assert.equal((await f.request()).status,503);assert.equal(f.calls.length,0);
  const options={ config: f.options.config,persistence: null,additionalRouteModules: [f.module] };
  assert.throws(()=>createCustomerComposition({ ...options,additionalRouteModules: [f.module,f.module] }),/COMPOSITION_INVALID/);
  for (const changed of [{ demoRuntime: true },{ mode: 'demo' }]) {
    assert.throws(()=>createCustomerComposition({ ...options,config: { ...options.config,...changed } }),/COMPOSITION_INVALID/);
  }
});
test('Customer route factory uses the same early Microsoft dispatch as explicit additional modules',async t=>{
  const f=await fixture(t);
  const composition=createCustomerComposition({ config: f.options.config,persistence: null,
    routeModulesFactory: ()=>[f.module],httpServerFactory: options=>{
      assert.equal(options.customerMicrosoftAuthenticationRouteModule,f.module);
      assert.equal(options.additionalRouteModules.includes(f.module),false);
      assert.equal(options.entraAuthService,null);
      return createHttpServer(options);
    } });
  assert.ok(composition.server);
  await composition.stop();
});
test('opt-in HTTP login/callback preserves exact browser transaction and only redirects to a fixed next ceremony',async t=>{
  const f=await fixture(t),start=await f.request();assert.equal(start.status,302);
  assert.equal(start.headers.location,f.state.startLogin.authorizationUrl);assert.deepEqual(start.headers['set-cookie'],[cookie(false)]);
  assert.equal(f.calls[0].name,'startLogin');assert.equal(f.calls[0].args[0].sourceKey,'f'.repeat(64));
  assert.deepEqual(f.sources,['127.0.0.1']);assert.equal(start.headers['cache-control'],'no-store');
  const result=await f.request(`/callback?state=${STATE}&code=synthetic-code`,{ headers: { cookie: cookie(false).split(';')[0],
    origin: undefined,'sec-fetch-site': 'cross-site' } });
  assert.equal(result.status,303);assert.equal(result.headers.location,'/?auth=microsoft_membership_required');
  assert.deepEqual(result.headers['set-cookie'],[cookie(true)]);
  const input=f.calls.find(value=>value.name==='complete').args[0];assert.equal(input.principal.userId,principal.userId);
  assert.equal(input.state,STATE);assert.equal(input.code,'synthetic-code');assert.equal(input.browserToken,BROWSER);
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(`${STATE}|${BROWSER}|synthetic-code|${CSRF}`));
});
test('HTTP choice is minimized and explicit selection accepts no Tenant/role/provider authority',async t=>{
  const f=await fixture(t),headers={ cookie: cookie(true).split(';')[0] };
  const choices=await f.request('/choices',{ headers });assert.equal(choices.status,200);
  const dto=JSON.parse(choices.body);assert.deepEqual(dto.items,[{ membershipId: id(6),displayName: 'Invited organization' }]);
  assert.equal(dto.csrfToken,CSRF);assert.doesNotMatch(choices.body,/roles|recipient|platform_admin|tenantId|provider/);
  for (const body of [{ membershipId: id(6),tenantId: id(2) },{ membershipId: id(6),roles: ['tenant_admin'] }]) {
    assert.equal((await f.request('/selection',{ method: 'POST',headers: { ...headers,'x-csrf-token': CSRF },body })).status,400);
  }
  assert.equal((await f.request('/selection',{ method: 'POST',headers,body: { membershipId: id(6) } })).status,403);
  assert.equal(f.calls.some(value=>value.name==='select'),false);
  const selected=await f.request('/selection',{ method: 'POST',headers: { ...headers,'x-csrf-token': CSRF },
    body: { membershipId: id(6) } });assert.equal(selected.status,204);assert.equal(selected.body,'');
  assert.equal(selected.headers['set-cookie'][0],session);assert.match(selected.headers['set-cookie'][1],/Max-Age=0/);
  assert.deepEqual(f.calls.find(value=>value.name==='select').args[1],{ membershipId: id(6) });
});
test('link start requires ordinary session CSRF while confirmation requires the separately bound flow CSRF and explicit intent',async t=>{
  const f=await fixture(t),headers={ cookie: cookie(true).split(';')[0] };
  assert.equal((await f.request('/link/start',{ method: 'POST',body: {} })).status,403);
  const started=await f.request('/link/start',{ method: 'POST',headers: { 'x-csrf-token': 'ordinary-session-csrf' },body: {} });
  assert.equal(started.status,200);assert.equal(JSON.parse(started.body).authorizationUrl,f.state.startLogin.authorizationUrl);
  assert.equal(f.calls.find(value=>value.name==='startLink').args[0].principal.userId,principal.userId);
  assert.equal((await f.request('/link/confirmation',{ headers })).status,200);
  assert.equal((await f.request('/link/confirm',{ method: 'POST',headers: { ...headers,'x-csrf-token': CSRF },
    body: { confirm: false } })).status,400);
  assert.equal((await f.request('/link/confirm',{ method: 'POST',headers: { ...headers,'x-csrf-token': 'ordinary-session-csrf' },
    body: { confirm: true } })).status,403);
  assert.equal((await f.request('/link/confirm',{ method: 'POST',headers: { ...headers,'x-csrf-token': CSRF },
    body: { confirm: true } })).status,204);
  assert.equal(f.calls.find(value=>value.name==='confirmLink').args[0].principal.userId,principal.userId);
  f.state.principal=null;
  assert.equal((await f.request('/link/confirmation',{ headers })).status,401);
});
test('methods, origins, unknown query/cookie/body and forwarding-source overrides fail before authority ports',async t=>{
  const f=await fixture(t);
  for (const [path,options,status] of [
    ['/login',{ method: 'POST' },405],['/login?tenantId=untrusted',{},400],['/login',{ headers: { host: 'other.invalid' } },400],
    ['/login',{ headers: { origin: 'https://other.invalid' } },403],['/login',{ headers: { 'sec-fetch-site': 'cross-site' } },403],
    ['/login',{ body: {} },400],['/choices',{},401],
    [`/callback?state=${STATE}&state=${STATE}&code=x`,{},400],[`/callback?state=${STATE}&code=x&userId=untrusted`,{},400],
  ]) assert.equal((await f.request(path,options)).status,status);
  assert.equal(f.calls.length,0);
  assert.equal((await f.request('/login',{ headers: { 'x-forwarded-for': '198.51.100.7' } })).status,302);
  assert.deepEqual(f.sources,['127.0.0.1']);
});
test('provider denial, unavailable proof and unsafe output cannot leak a provider payload or create an ordinary session',async t=>{
  const f=await fixture(t),headers={ cookie: cookie(false).split(';')[0] };
  f.state.complete=new EntraAuthenticationError('PRIVATE_PROVIDER_DETAIL');
  const failed=await f.request(`/callback?state=${STATE}&code=synthetic-code`,{ headers });
  assert.equal(failed.status,303);assert.equal(failed.headers.location,'/?auth=authentication_failed');
  assert.match(failed.headers['set-cookie'][0],/Max-Age=0/);
  f.state.startLogin={ ...f.state.startLogin,authorizationUrl: 'https://other.invalid/steal' };
  assert.equal((await f.request()).status,500);assert.equal(f.calls.some(value=>value.name==='select'),false);
  f.state.select={ status: 'authenticated',setCookie: `${session}; Domain=other.invalid` };
  assert.equal((await f.request('/selection',{ method: 'POST',body: { membershipId: id(6) },
    headers: { cookie: cookie(true).split(';')[0],'x-csrf-token': CSRF } })).status,500);
  assert.doesNotMatch(JSON.stringify(f.logs),/PRIVATE_PROVIDER_DETAIL|synthetic-code|steal|Domain=/);
});
test('inactive composition preserves legacy login and rejects closed Demo module injection',async t=>{
  const f=await fixture(t,{ injected: false });assert.equal((await f.request()).status,503);assert.equal(f.calls.length,0);
  assert.throws(()=>createApp({ ...f.options,config: { ...f.options.config,demoRuntime: true },
    customerMicrosoftAuthenticationRouteModule: f.module }),/COMPOSITION_INVALID/);
});
test('profile link status requires an ordinary current session and exposes only minimized server state without a flow cookie',async t=>{
  const f=await fixture(t),result=await f.request('/link/status');assert.equal(result.status,200);
  assert.deepEqual(Object.keys(JSON.parse(result.body)).sort(),['emailReauthenticationRequired','microsoftLinked','requestId','status']);
  assert.equal(JSON.parse(result.body).microsoftLinked,false);
  assert.equal(f.calls[0].name,'accountState');assert.equal(f.calls[0].args[0].principal.userId,principal.userId);
  f.state.principal=null;assert.equal((await f.request('/link/status')).status,401);
  assert.equal(f.calls.length,1);
});
