import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { syntheticHandoffCustomerRedirect,requireSyntheticHandoffCustomerRedirect } from '../src/domain/synthetic-handoff.js';
import { isOpaqueBrowserToken } from '../src/domain/identifiers.js';
import { isCustomerEmailBrowserToken } from '../src/identity/customer-email-browser-token.js';
import { readSyntheticHandoffBrowserCookie,readSyntheticHandoffCompletionCookie,serializeSyntheticHandoffBrowserCookie,
  serializeSyntheticHandoffCompletionCookie,clearSyntheticHandoffCookies } from '../src/identity/synthetic-handoff-cookie.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createPlatformSyntheticHandoffIntentCookie } from '../src/platform/identity/synthetic-handoff-intent-cookie.js';

const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
  customerOrigin: 'https://127.0.0.1',platformOrigin: 'https://localhost' };
const token=Buffer.alloc(32,4).toString('base64url'),flowId=randomUUID(),secret='i'.repeat(48);

test('shared canonical browser-value validation preserves the Customer compatibility function and rejects ambiguous encodings',()=>{
  assert.equal(isOpaqueBrowserToken,isCustomerEmailBrowserToken);
  for (const value of [token,Buffer.alloc(32,255).toString('base64url')]) assert.equal(isOpaqueBrowserToken(value),true);
  for (const value of [null,1,token+'=',token.slice(1),'x'.repeat(43),{ toString() { throw new Error('NOT_EVALUATED'); } }]) {
    assert.equal(isOpaqueBrowserToken(value),false);
  }
});

test('original Lax and completion Strict cookies stay narrow, secure, bounded and duplicate/encoding resistant',()=>{
  const binding=createSyntheticHandoffBrowserBinding({ scope,secret }),start=binding.issueStart(flowId),approval=binding.issueCode(flowId);
  const completion=binding.issueCompletion({ binding: { flowId,browserVerifier: start.browserVerifier,codeVerifier: approval.codeVerifier },
    browserToken: start.browserToken,now: new Date(1000),expiresAt: new Date(31_000) });
  const browser=serializeSyntheticHandoffBrowserCookie({ flowId,browserToken: start.browserToken });
  const finished=serializeSyntheticHandoffCompletionCookie(completion.value);
  assert.match(browser,/Path=\/api\/v1\/auth\/delegation; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
  assert.match(finished,/Path=\/api\/v1\/auth\/delegation; HttpOnly; SameSite=Strict; Secure; Max-Age=30$/);
  const pair=value=>value.split(';')[0];
  assert.deepEqual(readSyntheticHandoffBrowserCookie({ cookie: pair(browser) }),{ flowId,browserToken: start.browserToken });
  assert.equal(readSyntheticHandoffCompletionCookie({ cookie: pair(finished) }),completion.value);
  for (const [cookie,read] of [[browser,readSyntheticHandoffBrowserCookie],[finished,readSyntheticHandoffCompletionCookie]]) {
    for (const raw of [`${pair(cookie)}; ${pair(cookie)}`,pair(cookie)+'=',pair(cookie).replace(flowId,'INVALID'),
      `${'x'.repeat(8193)}; ${pair(cookie)}`]) assert.equal(read({ cookie: raw }),null);
    assert.doesNotMatch(cookie,/Domain=/);
  }
  assert.throws(()=>serializeSyntheticHandoffBrowserCookie({ flowId,browserToken: token },601),/INVALID/);
  assert.throws(()=>serializeSyntheticHandoffCompletionCookie(completion.value,31),/INVALID/);
  for (const value of clearSyntheticHandoffCookies()) assert.match(value,/Max-Age=0; Expires=Thu, 01 Jan 1970/);
  binding.destroy();
});

test('signed Ops intent survives an absent normal session but grants no identity and cannot cross scope or extend expiry',()=>{
  let now=1_000;
  const configuration={ scope,secret,clock: ()=>now },codec=createPlatformSyntheticHandoffIntentCookie(configuration);
  const cookie=codec.issue({ flowId,state: token }),raw=cookie.split(';')[0];
  assert.match(cookie,/Path=\/api\/v1\/platform\/auth\/delegation; HttpOnly; SameSite=Strict; Secure; Max-Age=600$/);
  assert.deepEqual(codec.read({ cookie: raw }),{ flowId,state: token });
  assert.equal(codec.read({ cookie: `${raw}; ${raw}` }),null);
  const [name,value]=raw.split('='),parts=value.split('.');
  for (const [index,change] of [[0,randomUUID()],[1,Buffer.alloc(32,5).toString('base64url')],
    [2,Buffer.alloc(32,6).toString('base64url')],[3,String(now+1_200_000)],[4,Buffer.alloc(32,7).toString('base64url')]]) {
    const changed=[...parts];changed[index]=change;assert.equal(codec.read({ cookie: `${name}=${changed.join('.')}` }),null);
  }
  for (const change of [{ environment: 'dev' },{ securityEpoch: randomUUID() },{ platformSecurityEpoch: 8 },
    { customerOrigin: 'https://127.0.0.2' },{ platformOrigin: 'https://localhost:8443' }]) {
    const foreign=createPlatformSyntheticHandoffIntentCookie({ ...configuration,scope: { ...scope,...change } });
    assert.equal(foreign.read({ cookie: raw }),null);foreign.destroy();
  }
  now=601_000;assert.equal(codec.read({ cookie: raw }),null);
  assert.match(codec.clear(),/Max-Age=0/);codec.destroy();
  assert.throws(()=>codec.issue({ flowId,state: token }),/UNAVAILABLE/);
});

test('Ops intent rejects malformed values, secrets, clock overflow and noncanonical random output without coercion',()=>{
  for (const changes of [{ secret: 'short' },{ secret: secret+'\n' },{ scope: { ...scope,environment: 'prod' } }]) {
    assert.throws(()=>createPlatformSyntheticHandoffIntentCookie({ scope,secret,...changes }),/INVALID/);
  }
  for (const changes of [{ clock: ()=>-1 },{ clock: ()=>Number.MAX_SAFE_INTEGER },{ randomToken: ()=> 'x'.repeat(43) }]) {
    const codec=createPlatformSyntheticHandoffIntentCookie({ scope,secret,...changes });
    assert.throws(()=>codec.issue({ flowId,state: token }),/INVALID/);codec.destroy();
  }
});


test('one canonical redirect contract rejects foreign URLs, duplicate/changed state, encoding aliases and object coercion',()=>{
  const code=Buffer.alloc(32,6).toString('base64url'),url=syntheticHandoffCustomerRedirect(scope,{ state: token,code });
  assert.equal(requireSyntheticHandoffCustomerRedirect(scope,url,token),url);
  let coercions=0;
  for (const value of [url.replace('127.0.0.1','foreign.test'),url+'&code='+code,url+'#fragment',
    url.replace('state='+token,'state='+code),url.replace('state=','state=%25'),
    { toString() { coercions++;return url; } }]) {
    assert.throws(()=>requireSyntheticHandoffCustomerRedirect(scope,value,token),/INVALID/);
  }
  assert.throws(()=>serializeSyntheticHandoffBrowserCookie({ flowId: { toString() { coercions++;return flowId; } },browserToken: token }),
    /INVALID/);
  assert.equal(coercions,0);
});
