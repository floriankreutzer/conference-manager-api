import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPlatformOwnerCustomerIntentCookie } from '../src/platform/identity/owner-customer-intent-cookie.js';
import { createPlatformSyntheticHandoffIntentCookie } from '../src/platform/identity/synthetic-handoff-intent-cookie.js';

const token=Buffer.alloc(32,4).toString('base64url'),nonce=Buffer.alloc(32,5).toString('base64url');

test('owner intent isolates synthetic names and signatures, survives login without identity and cannot cross source scope',()=>{
  const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
    customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.test' };
  const flowId=randomUUID(),intent={ flowId,state: token };let now=1000;
  const options={ scope,secret: 'i'.repeat(48),clock: ()=>now,randomToken: ()=>nonce };
  const own=createPlatformOwnerCustomerIntentCookie(options),synthetic=createPlatformSyntheticHandoffIntentCookie(options);
  const cookie=own.issue(intent),pair=value=>value.split(';')[0],legacy=pair(synthetic.issue(intent));
  assert.match(cookie,/^cm_platform_owner_intent=.*Path=\/api\/v1\/platform\/auth\/owner; HttpOnly; SameSite=Strict; Secure; Max-Age=600$/);
  assert.deepEqual(own.read({ cookie: pair(cookie) }),intent);assert.equal(synthetic.read({ cookie: pair(cookie) }),null);
  assert.equal(own.read({ cookie: legacy }),null);
  assert.equal(own.read({ cookie: legacy.replace('cm_platform_synthetic_intent','cm_platform_owner_intent') }),null);
  assert.equal(synthetic.read({ cookie: pair(cookie).replace('cm_platform_owner_intent','cm_platform_synthetic_intent') }),null);
  assert.equal(own.read({ cookie: `${pair(cookie)}; ${pair(cookie)}` }),null);
  for (const changes of [{ environment: 'dev' },{ securityEpoch: randomUUID() },{ platformSecurityEpoch: 8 },
    { customerOrigin: 'https://other.example.test' },{ platformOrigin: 'https://ops-other.example.test' }]) {
    const foreign=createPlatformOwnerCustomerIntentCookie({ ...options,scope: { ...scope,...changes } });
    assert.equal(foreign.read({ cookie: pair(cookie) }),null);foreign.destroy();
  }
  now=601000;assert.equal(own.read({ cookie: pair(cookie) }),null);
  assert.match(own.clear(),/^cm_platform_owner_intent=; Path=\/api\/v1\/platform\/auth\/owner;.*Max-Age=0/);
  own.destroy();synthetic.destroy();assert.throws(()=>own.issue(intent),/UNAVAILABLE/);
});
