import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOwnerCustomerHandoffBrowserBinding } from '../src/identity/owner-customer-handoff-browser-binding.js';
import { readOwnerHandoffBrowserCookie,readOwnerHandoffCompletionCookie,serializeOwnerHandoffBrowserCookie,
  serializeOwnerHandoffCompletionCookie,clearOwnerHandoffCookies } from '../src/identity/owner-customer-handoff-cookie.js';
import { readSyntheticHandoffBrowserCookie,readSyntheticHandoffCompletionCookie }
  from '../src/identity/synthetic-handoff-cookie.js';
import { createCustomerHandoffCookieCodec } from '../src/identity/customer-handoff-cookie.js';

test('REAL owner cookies are narrowly scoped, bounded, duplicate-resistant and isolated from synthetic cookie names',()=>{
  const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
    customerOrigin: 'https://127.0.0.1',platformOrigin: 'https://localhost' };
  const binding=createOwnerCustomerHandoffBrowserBinding({ scope,secret: 'h'.repeat(48) }),flowId=randomUUID();
  const start=binding.issueStart(flowId),code=binding.issueCode(flowId);
  const completion=binding.issueCompletion({ binding: { flowId,browserVerifier: start.browserVerifier,codeVerifier: code.codeVerifier },
    browserToken: start.browserToken,now: new Date(1000),expiresAt: new Date(31_000) });
  const original=serializeOwnerHandoffBrowserCookie({ flowId,browserToken: start.browserToken });
  const finished=serializeOwnerHandoffCompletionCookie(completion.value),pair=value=>value.split(';')[0];
  assert.match(original,/^cm_owner_browser=.*Path=\/api\/v1\/auth\/owner; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
  assert.match(finished,/^cm_owner_completion=.*Path=\/api\/v1\/auth\/owner; HttpOnly; SameSite=Strict; Secure; Max-Age=30$/);
  assert.deepEqual(readOwnerHandoffBrowserCookie({ cookie: pair(original) }),{ flowId,browserToken: start.browserToken });
  assert.equal(readOwnerHandoffCompletionCookie({ cookie: pair(finished) }),completion.value);
  assert.equal(readSyntheticHandoffBrowserCookie({ cookie: pair(original) }),null);
  assert.equal(readSyntheticHandoffCompletionCookie({ cookie: pair(finished) }),null);
  for (const [cookie,read] of [[original,readOwnerHandoffBrowserCookie],[finished,readOwnerHandoffCompletionCookie]]) {
    for (const raw of [`${pair(cookie)}; ${pair(cookie)}`,pair(cookie)+'=',pair(cookie).replace(flowId,'INVALID'),
      pair(cookie).replace('cm_owner_','cm_synthetic_'),`${'x'.repeat(8193)}; ${pair(cookie)}`]) {
      assert.equal(read({ cookie: raw }),null);
    }
    assert.doesNotMatch(cookie,/Domain=/);
  }
  for (const seconds of [0,-1,601,1.5,NaN]) {
    assert.throws(()=>serializeOwnerHandoffBrowserCookie({ flowId,browserToken: start.browserToken },seconds),/INVALID/);
  }
  for (const seconds of [0,-1,31,1.5,NaN]) assert.throws(()=>serializeOwnerHandoffCompletionCookie(completion.value,seconds),/INVALID/);
  assert.equal(clearOwnerHandoffCookies().length,2);
  for (const cleared of clearOwnerHandoffCookies()) {
    assert.match(cleared,/^cm_owner_.*Path=\/api\/v1\/auth\/owner;.*Max-Age=0; Expires=Thu, 01 Jan 1970/);
  }
  for (const kind of [undefined,null,{},'real','../synthetic']) assert.throws(()=>createCustomerHandoffCookieCodec(kind),/KIND_INVALID/);
  binding.destroy();
});
