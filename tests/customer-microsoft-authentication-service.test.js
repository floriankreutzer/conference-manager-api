import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCustomerMicrosoftAuthenticationService } from '../src/identity/customer-microsoft-authentication-service.js';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
import { readCustomerMicrosoftTransactionCookie,serializeCustomerMicrosoftTransactionCookie,clearCustomerMicrosoftTransactionCookie }
  from '../src/identity/customer-microsoft-cookie.js';
const id=n=>`b2000000-0000-4000-8000-${String(n).padStart(12,'0')}`,state='S'.repeat(43),now='2026-10-20T12:00:00.000Z';
const principal={ tenantId: id(1),userId: id(2),providerIdentity: { provider: 'email_code',reference: id(3) },roles: ['employee'],
  permissions: [],
  session: { id: id(4),securityVersion: 7,issuedAt: now,expiresAt: '2026-10-20T13:00:00.000Z' } };
function fixture({ providerReject=false,extraClaims=false,creationDenied=false,verificationDenied=false }={}) {
  const records=new Map(),calls={ redeem: [],verified: [],failed: [],created: [] };let tokens=0;
  const binding=()=>createCustomerMicrosoftFlowBinding({ environment: 'int',secret: 's'.repeat(48),
    randomToken: ()=>++tokens===1 ? state : Buffer.alloc(32,tokens).toString('base64url') });
  const repository={ async create(value) {
    calls.created.push(value);if (creationDenied) return null;
    records.set(value.flowId,{ ...value,status: 'started',startedAt: now });return { flowId: value.flowId,startedAt: now };
  },async reserve(value) {
    const row=records.get(value.flowId);
    if (!row || row.status!=='started' || row.stateHash!==value.stateHash || !binding().matchesBrowser({
      context: { flowId: row.flowId,purpose: row.purpose,stage: 'authorization' },browserToken: value.browserToken,
      browserVerifier: row.browserVerifier })) return null;
    row.status='redeeming';return { flowId: row.flowId,purpose: row.purpose,nonceHash: row.nonceHash,startedAt: row.startedAt };
  },async verified(value) {
    calls.verified.push(value);if (verificationDenied) return false;records.get(value.flowId).status='verified';return true;
  },async fail(value) { calls.failed.push(value);records.get(value.flowId).status='failed'; } };
  let sent;
  const entraClient={ async authorizationUrl(value) {
    sent=value;return `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?state=${value.state}`; },
    async redeemAuthorizationCode(value) {
      calls.redeem.push(value);assert.equal(value.expectedNonce,sent.nonce);
      assert.equal(value.expectedNonceHash,createHash('sha256').update(value.expectedNonce).digest('hex'));
      assert.equal(createHash('sha256').update(value.codeVerifier).digest('base64url'),sent.codeChallenge);
      if (providerReject) throw new Error('PRIVATE_PROVIDER_TOKEN');return Object.freeze({});
    },async verifyPrimary() { return { provider: 'microsoft_entra',tenantReference: id(8),userReference: id(9),authenticatedAt: now,
      ...(extraClaims ? { email: 'Untrusted@example.test' } : {}) }; } };
  const service=()=>createCustomerMicrosoftAuthenticationService({ repository,entraClient,flowBinding: binding(),idFactory: ()=>id(5) });
  const start=async(link=false)=>{
    const input={ correlationId: id(6),sourceKey: 'f'.repeat(64),...(link ? { principal } : {}) };
    const started=await service()[link ? 'startLink' : 'startLogin'](input);
    return { started,cookie: readCustomerMicrosoftTransactionCookie({ cookie: started.setCookie?.split(';')[0] }) };
  };
  const complete=cookie=>({ ...cookie,state,code: 'synthetic-code',providerError: null,correlationId: id(7),principal: null });
  return { service,start,complete,calls,records };
}
for (const link of [false,true]) test(
  `${link ? 'link' : 'login'} primary flow survives instance changes and returns only the next explicit ceremony`,async()=>{
  const f=fixture(),{ started,cookie }=await f.start(link);
  assert.equal(started.status,'redirect');assert.match(started.setCookie,/HttpOnly; SameSite=Lax; Secure/);
  const result=await f.service().complete({ ...f.complete(cookie),principal: link ? principal : null });
  assert.equal(result.status,link ? 'link_confirmation_required' : 'membership_required');
  assert.match(result.setCookie,/SameSite=Strict; Secure; Max-Age=300/);assert.match(result.csrfToken,/^[a-f0-9]{64}$/);
  assert.notEqual(readCustomerMicrosoftTransactionCookie({ cookie: result.setCookie.split(';')[0] }).browserToken,cookie.browserToken);
  assert.equal(result.principal,undefined);assert.equal(result.userId,undefined);assert.equal(f.calls.redeem.length,1);
  assert.deepEqual(Object.keys(f.calls.verified[0].identity).sort(),['authenticatedAt','provider','tenantReference','userReference']);
  assert.equal((await f.service().complete({ ...f.complete(cookie),principal: link ? principal : null })).status,'rejected');
  assert.equal(f.calls.redeem.length,1);assert.equal(f.calls.created[0].nonce,undefined);assert.equal(f.calls.created[0].state,undefined);
});
test('foreign browser/state and throttled allocation never exchange a code or grant local identity',async()=>{
  const f=fixture(),{ cookie }=await f.start();
  assert.equal((await f.service().complete({ ...f.complete(cookie),browserToken: 'W'.repeat(43) })).status,'rejected');
  assert.equal((await f.service().complete({ ...f.complete(cookie),state: 'W'.repeat(43) })).status,'rejected');
  assert.equal(f.calls.redeem.length,0);assert.equal(f.calls.verified.length,0);
  const denied=fixture({ creationDenied: true });
  assert.equal((await denied.start()).started.status,'rejected');assert.equal(denied.calls.redeem.length,0);
});
test('provider failure, untrusted extra claims and lost fresh email session consume the pending exchange without admission',async()=>{
  for (const options of [{ providerReject: true },{ extraClaims: true }]) {
    const f=fixture(options),{ cookie }=await f.start();
    await assert.rejects(f.service().complete(f.complete(cookie)),error=>{
      assert.equal(error.code,'CUSTOMER_MICROSOFT_PRIMARY_REJECTED');assert.equal(error.cause,undefined);return true;
    });
    assert.equal(f.calls.verified.length,0);assert.equal(f.calls.failed.length,1);
  }
  const link=fixture(),{ cookie }=await link.start(true);
  await assert.rejects(link.service().complete(link.complete(cookie)),/PRIMARY_REJECTED/);
  assert.equal(link.calls.redeem.length,0);assert.equal(link.calls.verified.length,0);assert.equal(link.calls.failed.length,1);
});
test('explicit provider denial and current-repository refusal cannot create a choice or link confirmation',async()=>{
  const f=fixture(),{ cookie }=await f.start();
  assert.equal((await f.service().complete({ ...f.complete(cookie),code: undefined,providerError: 'access_denied' })).status,'rejected');
  assert.equal(f.calls.redeem.length,0);assert.equal(f.calls.failed.length,1);
  const denied=fixture({ verificationDenied: true }),started=await denied.start();
  assert.equal((await denied.service().complete(denied.complete(started.cookie))).status,'rejected');
});
test('browser authority overrides and Microsoft-only sessions cannot start account linking',async()=>{
  const f=fixture();
  await assert.rejects(f.service().startLogin({ correlationId: id(6),sourceKey: 'f'.repeat(64),tenantId: id(1) }),/INPUT_INVALID/);
  await assert.rejects(f.service().startLink({ correlationId: id(6),sourceKey: 'f'.repeat(64),principal: {
    ...principal,providerIdentity: { provider: 'microsoft_entra',reference: 'synthetic-subject' } } }),/EMAIL_REAUTHENTICATION_REQUIRED/);
  assert.equal(f.calls.created.length,0);
});
test('transaction cookie is scoped, duplicate-safe and separate from any authenticated session',()=>{
  const cookie=serializeCustomerMicrosoftTransactionCookie({ flowId: id(5),browserToken: state });
  assert.match(cookie,/^cm_customer_microsoft_tx=/);
  assert.match(cookie,/Path=\/api\/v1\/auth\/microsoft; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
  assert.equal(cookie.includes('Domain='),false);const header=cookie.split(';')[0];
  assert.deepEqual(readCustomerMicrosoftTransactionCookie({ cookie: `cm_session=unrelated; ${header}` }),
    { flowId: id(5),browserToken: state });
  assert.equal(readCustomerMicrosoftTransactionCookie({ cookie: `${header}; ${header}` }),null);
  assert.equal(readCustomerMicrosoftTransactionCookie({ cookie: 'cm_customer_microsoft_tx=invalid' }),null);
  assert.match(clearCustomerMicrosoftTransactionCookie(),/Max-Age=0; Expires=Thu, 01 Jan 1970/);
});
