import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { createCustomerEmailAuthenticationRouteModule } from '../src/http/customer-email-authentication-routes.js';
import { createCustomerEmailAuthenticationService } from '../src/identity/customer-email-authentication-service.js';
import { createCustomerEmailSourceKey } from '../src/identity/customer-email-source-key.js';
import { serializeCustomerEmailTransactionCookie } from '../src/identity/customer-email-cookie.js';
import { serializeSessionCookie } from '../src/identity/session-cookie.js';

const ORIGIN='https://customer.example',ROOT='/api/v1/auth/email';
const id=n => `f2000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const BROWSER=Buffer.alloc(32,1).toString('base64url'),CHOICE=Buffer.alloc(32,2).toString('base64url');
const NOW=Date.parse('2026-10-19T12:00:00.000Z'),CSRF='a'.repeat(64);
const proof=(status='code_required') => ({ status,challengeId: id(1),browserToken: status==='code_required' ? BROWSER : CHOICE,
  csrfToken: CSRF,expiresAt: new Date(NOW+(status==='code_required' ? 600_000 : 300_000)).toISOString() });
const cookie=(status='code_required') => serializeCustomerEmailTransactionCookie(proof(status),{ maxAgeSeconds: 600 }).split(';')[0];
const session=serializeSessionCookie(Buffer.alloc(32,3).toString('base64url'),{ secure: true,maxAgeSeconds: 28800 });

async function fixture(t,{ injected = true } = {}) {
  const calls=[],logs=[]; const state={ request: proof(),pending: proof(),verify: proof('membership_required'),
    choices: { status: 'membership_required',items: [{ membershipId: id(2),displayName: 'Invited organisation' }] },
    select: { status: 'authenticated',setCookie: session } };
  const operation=name => async (...args) => {
    calls.push({ name,args }); if (state[name] instanceof Error) throw state[name]; return state[name];
  };
  const sourceKey=createCustomerEmailSourceKey({ environment: 'int',secret: 'synthetic-http-source-key-at-least-32-bytes' });
  const service=createCustomerEmailAuthenticationService({ sourceKey,
    challenges: { request: operation('request'),pending: operation('pending'),verify: operation('verify') },
    admission: { choices: operation('choices'),select: operation('select') } });
  const module=createCustomerEmailAuthenticationRouteModule({ service,publicOrigin: ORIGIN,clock: () => NOW });
  const config={ ...loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: ORIGIN,RATE_LIMIT_MAX: '120' }) };
  const server=createHttpServer({ config,logger: createLogger({ write: line => logs.push(line) }),
    additionalRouteModules: injected ? [module] : [] });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { sourceKey.destroy(); await new Promise(resolve => server.close(resolve)); });
  async function request({ path='/challenges',method='POST',body={ recipient: 'Invitee@example.com',locale: 'de' },headers={} } = {}) {
    const raw=body===undefined || body===null ? null : typeof body==='string' ? body : JSON.stringify(body);
    return new Promise((resolve,reject) => {
      const requestHeaders={ host: 'customer.example',origin: ORIGIN,'sec-fetch-site': 'same-origin',
        ...(raw===null ? {} : { 'content-type': 'application/json','content-length': Buffer.byteLength(raw) }),...headers };
      const req=http.request({ hostname: '127.0.0.1',port: server.address().port,path: `${ROOT}${path}`,method,
        headers: Object.fromEntries(Object.entries(requestHeaders).filter(([,value]) => value!==undefined)) },res => {
        const chunks=[]; res.on('data',chunk => chunks.push(chunk)); res.on('end',() => {
          const text=Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode,headers: res.headers,text,body: text ? JSON.parse(text) : null });
        });
      });
      req.on('error',reject); if (raw!==null) req.write(raw); req.end();
    });
  }
  return { calls,logs,state,request,sourceKey };
}

test('loopback HTTP retains browser proof only in HttpOnly cookies and emits a session only after explicit selection',async t => {
  const f=await fixture(t);
  let answer=await f.request(); assert.equal(answer.status,202);
  assert.deepEqual(Object.keys(answer.body).sort(),['csrfToken','expiresAt','requestId','status']);
  assert.equal(answer.headers['cache-control'],'no-store');
  assert.match(answer.headers['set-cookie'][0],/Path=\/api\/v1\/auth\/email; HttpOnly; SameSite=Strict; Secure; Max-Age=600$/);
  assert.doesNotMatch(answer.text,/Invitee|challengeId|browserToken|tenantId|roles|organisation/);
  assert.equal(f.calls[0].args[0].sourceKey,f.sourceKey.fingerprint('127.0.0.1'));
  assert.equal(f.calls[0].args[0].sourceAddress,undefined);
  answer=await f.request({ path: '/pending',method: 'GET',body: null,headers: { cookie: cookie() } });
  assert.equal(answer.status,200); assert.equal(answer.headers['set-cookie'],undefined);
  answer=await f.request({ path: '/verify',body: { code: '00123456' },
    headers: { cookie: cookie(),'x-csrf-token': CSRF,'x-forwarded-for': '203.0.113.88' } });
  assert.equal(answer.status,200); assert.match(answer.headers['set-cookie'][0],new RegExp(CHOICE));
  assert.equal(f.calls.at(-1).args[0].sourceKey,f.sourceKey.fingerprint('127.0.0.1'));
  assert.equal(f.calls.at(-1).args[0].code,'00123456'); assert.doesNotMatch(answer.text,/00123456|cm_session/);
  answer=await f.request({ path: '/choices',method: 'GET',body: null,headers: { cookie: cookie('membership_required') } });
  assert.equal(answer.status,200); assert.deepEqual(answer.body.items,f.state.choices.items);
  answer=await f.request({ path: '/selection',body: { membershipId: id(2) },
    headers: { cookie: cookie('membership_required'),'x-csrf-token': CSRF } });
  assert.equal(answer.status,204); assert.equal(answer.text,'');
  assert.equal(answer.headers['set-cookie'][0],session); assert.match(answer.headers['set-cookie'][1],/Max-Age=0/);
  assert.deepEqual(f.calls.at(-1).args[1],{ membershipId: id(2) });
  assert.match(f.calls.at(-1).args[0].correlationId,/^[0-9a-f-]{36}$/);
  assert.doesNotMatch(f.logs.join(''),new RegExp(`Invitee|00123456|${BROWSER}|${CHOICE}|${CSRF}|${id(1)}|${id(2)}`));
});

test('email HTTP rejects foreign origins, query authority, malformed bodies and absent cookie/CSRF before service calls',async t => {
  const f=await fixture(t);
  for (const input of [
    { headers: { origin: undefined } },{ headers: { origin: 'https://foreign.example' } },
    { headers: { origin: `${ORIGIN}/` } },{ headers: { 'sec-fetch-site': 'cross-site' } },
    { path: '/challenges?tenantId=foreign' },{ body: { recipient: 'Invitee@example.com',locale: 'de',roles: ['tenant_admin'] } },
    { body: { recipient: 'bad',locale: 'de' } },{ body: { recipient: 'Invitee@example.com',locale: 'fr' } },
    { body: { recipient: 'Invitee@example.com',locale: 'de',pad: 'x'.repeat(1100) } },
    { headers: { 'content-type': 'text/plain' } },{ headers: { 'content-encoding': 'gzip' } },
    { path: '/verify',body: { code: '00123456' } },
    { path: '/verify',body: { code: '00123456' },headers: { cookie: cookie() } },
    { path: '/verify',body: { code: 12345678 },headers: { cookie: cookie(),'x-csrf-token': CSRF } },
    { path: '/selection',body: { membershipId: id(2),tenantId: id(3) },
      headers: { cookie: cookie('membership_required'),'x-csrf-token': CSRF } },
    { path: '/choices',method: 'GET',body: null,headers: { cookie: `${cookie()}; ${cookie()}` } },
    { path: '/pending',method: 'GET',body: 'unexpected',headers: { cookie: cookie() } },
  ]) {
    const answer=await f.request(input); assert.ok(answer.status>=400 && answer.status<500,`${JSON.stringify(input)}:${answer.status}`);
  }
  assert.equal(f.calls.length,0);
  for (const path of ['/challenges','/pending','/verify','/choices','/selection']) {
    const answer=await f.request({ path,method: 'DELETE',body: null }); assert.equal(answer.status,405);
  }
  assert.equal(f.calls.length,0);
});

test('uniform rejection and bounded provider-free errors never release proof, roles or a premature session',async t => {
  const f=await fixture(t);
  for (const name of ['request','verify']) {
    f.state[name]={ status: 'limited',recipient: 'private@example.com' };
    const answer=await f.request(name==='verify' ? { path: '/verify',body: { code: '00123456' },
      headers: { cookie: cookie(),'x-csrf-token': CSRF } } : {});
    assert.equal(answer.status,429); assert.equal(answer.headers['retry-after'],'60');
    assert.equal(answer.headers['set-cookie'],undefined); assert.doesNotMatch(answer.text,/private|00123456|browserToken/);
  }
  for (const [name,path,method,body] of [['pending','/pending','GET',null],['choices','/choices','GET',null],
    ['verify','/verify','POST',{ code: '00123456' }],['select','/selection','POST',{ membershipId: id(2) }]]) {
    f.state[name]={ status: 'rejected',tenantId: id(77) };
    const answer=await f.request({ path,method,body,headers: { cookie: cookie(),'x-csrf-token': CSRF } });
    assert.equal(answer.status,401); assert.equal(answer.body.error.code,'AUTHENTICATION_REJECTED');
    assert.equal(answer.headers['set-cookie'],undefined); assert.doesNotMatch(answer.text,new RegExp(id(77)));
  }
  f.state.select=new Error('synthetic private SQL code recipient cookie detail');
  const answer=await f.request({ path: '/selection',body: { membershipId: id(2) },
    headers: { cookie: cookie('membership_required'),'x-csrf-token': CSRF } });
  assert.equal(answer.status,500); assert.equal(answer.headers['set-cookie'],undefined);
  assert.doesNotMatch(answer.text,/synthetic|SQL|recipient|cookie/); assert.doesNotMatch(f.logs.join(''),/synthetic private SQL/);
  assert.equal(f.calls.filter(call => call.name==='select').length,2);
});

test('invalid private outputs fail closed and provider authority fields are stripped from the public choice projection',async t => {
  const f=await fixture(t);
  f.state.request={ ...proof(),expiresAt: new Date(NOW+601_000).toISOString() };
  let answer=await f.request(); assert.equal(answer.status,500); assert.equal(answer.headers['set-cookie'],undefined);
  f.state.request={ ...proof(),browserToken: 'invalid' };
  answer=await f.request(); assert.equal(answer.status,500); assert.equal(answer.headers['set-cookie'],undefined);
  f.state.choices.items[0]={ ...f.state.choices.items[0],tenantId: id(3),roles: ['tenant_admin'],recipient: 'private@example.com' };
  answer=await f.request({ path: '/choices',method: 'GET',body: null,headers: { cookie: cookie('membership_required') } });
  assert.equal(answer.status,200); assert.deepEqual(Object.keys(answer.body.items[0]).sort(),['displayName','membershipId']);
  f.state.choices.items[0].displayName='unsafe\nlabel';
  answer=await f.request({ path: '/choices',method: 'GET',body: null,headers: { cookie: cookie('membership_required') } });
  assert.equal(answer.status,500);
  for (const value of [session.replace('; Secure',''),`${session}; Domain=foreign.example`,`${session}\r\nInjected: yes`]) {
    f.state.select={ status: 'authenticated',setCookie: value };
    answer=await f.request({ path: '/selection',body: { membershipId: id(2) },
      headers: { cookie: cookie('membership_required'),'x-csrf-token': CSRF } });
    assert.equal(answer.status,500); assert.equal(answer.headers['set-cookie'],undefined);
  }
});

test('ordinary app composition exposes no email route without explicit module injection',async t => {
  const f=await fixture(t,{ injected: false });
  const answer=await f.request(); assert.equal(answer.status,404); assert.equal(f.calls.length,0);
});
