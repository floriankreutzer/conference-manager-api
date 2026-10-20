import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerAccessDeliveryWorker } from '../src/application/customer-access-delivery-worker.js';
import { TransactionalEmailError } from '../src/integrations/resend-email-client.js';

const id=n => `d1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pending=extra => ({ deliveryId: id(1),leaseId: id(2),attemptCount: 1,
  message: { recipient: 'Synthetic@example.com',subject: 'Synthetic invitation',text: 'Synthetic content',deliveryId: id(1) },...extra });
function fixture({ value=pending(),send=async () => ({ status: 'accepted',messageId: id(3) }),
  settle=async value => value.status,random=() => 0.5 } = {}) {
  const claims=[],sends=[],settlements=[];
  const worker=createCustomerAccessDeliveryWorker({ repository: {
    async claim() { claims.push(true);return value; },async settle(value) { settlements.push(value);return settle(value); },
  },provider: { async send(value) { sends.push(value);return send(value); } },random });
  return { worker,claims,sends,settlements };
}

test('one explicit claim sends its stable closed message once and settles acceptance without Tenant or session authority',async () => {
  const f=fixture();assert.deepEqual(await f.worker.runOnce(),{ status: 'accepted' });
  assert.deepEqual(f.sends,[pending().message]);
  assert.deepEqual(f.settlements,[{ deliveryId: id(1),leaseId: id(2),status: 'accepted',
    providerMessageId: id(3),retryDelayMs: null }]);
  assert.equal(f.claims.length,1);
  const idle=fixture({ value: null });assert.deepEqual(await idle.worker.runOnce(),{ status: 'idle' });
  assert.equal(idle.sends.length,0);assert.equal(idle.settlements.length,0);
});

test('only classified transient failures schedule bounded jitter; attempt five never schedules another send',async () => {
  for (const [code,guidance,delay] of [['EMAIL_RATE_LIMITED',60000,60000],['EMAIL_PROVIDER_UNAVAILABLE',null,1500]]) {
    const f=fixture({ send: async () => { throw new TransactionalEmailError(code,{ retryable: true,retryAfterMs: guidance }); } });
    assert.equal((await f.worker.runOnce()).status,'queued');assert.equal(f.sends.length,1);
    assert.equal(f.settlements[0].retryDelayMs,delay);assert.equal(f.settlements[0].providerMessageId,null);
  }
  const exhausted=fixture({ value: pending({ attemptCount: 5 }),
    send: async () => { throw new TransactionalEmailError('EMAIL_PROVIDER_UNAVAILABLE',{ retryable: true }); } });
  assert.equal((await exhausted.worker.runOnce()).status,'failed');assert.equal(exhausted.settlements[0].retryDelayMs,null);
});

test('permanent, malformed and unknown failures never expose private errors or schedule a blind retry',async () => {
  for (const error of [new Error('private recipient code credential'),
    new TransactionalEmailError('EMAIL_DELIVERY_CONFLICT',{ retryable: true }),
    new TransactionalEmailError('EMAIL_PROVIDER_NOT_AUTHORIZED'),
    { name: 'TransactionalEmailError',code: 'invented',retryable: true }]) {
    const f=fixture({ send: async () => { throw error; } });
    assert.deepEqual(await f.worker.runOnce(),{ status: 'failed' });
    assert.doesNotMatch(JSON.stringify(f.settlements),/private|credential|recipient|code/);
  }
});

test('lost or failed settlement never sends again and allows a subsequent explicit worker run',async () => {
  const lost=fixture({ settle: async () => null });assert.equal((await lost.worker.runOnce()).status,'lease_lost');
  assert.equal(lost.sends.length,1);
  const expired=fixture({ send: async () => { throw new TransactionalEmailError('EMAIL_RATE_LIMITED',{ retryable: true }); },
    settle: async () => 'failed' });assert.equal((await expired.worker.runOnce()).status,'failed');
  let attempts=0;
  const failed=fixture({ settle: async () => { if (++attempts===1) throw new Error('SYNTHETIC_COMMIT_FAILURE');return 'accepted'; } });
  await assert.rejects(failed.worker.runOnce(),/SYNTHETIC_COMMIT_FAILURE/);assert.equal(failed.sends.length,1);
  assert.equal((await failed.worker.runOnce()).status,'accepted');assert.equal(failed.sends.length,2);
});

test('overlapping invocations share one in-flight claim and do not replace the lease or send twice',async () => {
  let release,entered;
  const sending=new Promise(resolve => { entered=resolve; });
  const provider=new Promise(resolve => { release=resolve; });
  const f=fixture({ send: () => { entered();return provider; } });
  const first=f.worker.runOnce();await sending;
  assert.deepEqual(await f.worker.runOnce(),{ status: 'busy' });assert.equal(f.claims.length,1);assert.equal(f.sends.length,1);
  release({ status: 'accepted',messageId: id(3) });assert.equal((await first).status,'accepted');
});

test('malformed authority, accessor payloads and provider results fail closed without copying options',async () => {
  const accessor={ ...pending().message };Object.defineProperty(accessor,'text',{ enumerable: true,get() { throw new Error('GETTER'); } });
  for (const value of [pending({ tenantId: id(9) }),pending({ leaseId: 'invalid' }),pending({ attemptCount: 6 }),
    pending({ message: { ...pending().message,headers: { authorization: 'private' } } }),pending({ message: accessor }),
    pending({ message: { ...pending().message,deliveryId: id(9) } })]) {
    const f=fixture({ value });await assert.rejects(f.worker.runOnce(),/CUSTOMER_ACCESS_DELIVERY_CONTRACT_INVALID/);
    assert.equal(f.sends.length,0);assert.equal(f.settlements.length,0);
  }
  for (const receipt of [{ status: 'delivered',messageId: id(3) },{ status: 'accepted',messageId: 'private' },
    { status: 'accepted',messageId: id(3),providerPayload: 'private' }]) {
    const f=fixture({ send: async () => receipt });await assert.rejects(f.worker.runOnce(),/CUSTOMER_ACCESS_DELIVERY_CONTRACT_INVALID/);
    assert.equal(f.sends.length,1);assert.equal(f.settlements.length,0);
  }
});
