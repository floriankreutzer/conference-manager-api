import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { lockCustomerDeliveryEligibility } from '../src/persistence/postgres/customer-access-delivery-eligibility.js';
import { createPostgresProtectedRealDeliveryEligibility } from '../src/persistence/postgres/protected-real-delivery-eligibility.js';
import { createProtectedCustomerAccessDeliveryWorker }
  from '../src/protected-customer-access-delivery-composition.js';
import { createPostgresProtectedRuntimeExecutionScopes,requireProtectedRuntimeSharedExecutionScope }
  from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';

const epoch=randomUUID(),tenantId=randomUUID(),mailboxId=randomUUID();
const invitation={ purpose: 'membership_invitation',tenant_id: tenantId,mailbox_id: mailboxId,
  id: randomUUID(),invitation_id: randomUUID(),invitation_revision: 1,challenge_id: null };
function fakePool(respond=()=>({ rowCount: 1,rows: [] })) {
  const queries=[];let connections=0;
  const client={ async query(value) {
    queries.push(value);
    if (typeof value==='object' && value.text.includes('pg_try_advisory')) return { rowCount: 1,rows: [{ acquired: true }] };
    return respond(value);
  },release() {} };
  return { queries,client,pool: { query: value=>client.query(value),async connect() { connections++;return client; } },
    connections: ()=>connections };
}

test('protected invitation qualification must return strict true before ordinary recipient eligibility or decryption',async()=>{
  for (const allowed of [false,null,undefined,'true',1]) {
    const f=fakePool();
    assert.equal(await lockCustomerDeliveryEligibility(f.client,'int',invitation,
      { async allowsWithClient(client,id) { assert.equal(client,f.client);assert.equal(id,tenantId);return allowed; } }),false);
    assert.equal(f.queries.length,0);
  }
  const f=fakePool();
  await assert.rejects(lockCustomerDeliveryEligibility(f.client,'int',invitation,
    { async allowsWithClient() { throw new Error('PROTECTED_CUSTODY_UNAVAILABLE'); } }),/PROTECTED_CUSTODY_UNAVAILABLE/);
  assert.equal(f.queries.length,0);
});

test('code delivery qualifies only captured entries and cannot expand an old snapshot through another real membership',async()=>{
  const entries=[1,2,3].map(()=>({ tenantId: randomUUID(),membershipId: randomUUID(),userId: null,userSecurityVersion: null,
    invitationId: randomUUID(),invitationRevision: 1 }));
  for (const allowed of [entries[1].tenantId,null]) {
    const visited=[],f=fakePool(value=>({ rowCount: 1,rows: value?.name==='customer-delivery-code-snapshot'
      ? [{ admission_snapshot: entries }] : value?.name==='customer-delivery-code-member-lock' ? [{ user_id: null }] : [] }));
    const result=await lockCustomerDeliveryEligibility(f.client,'int',{ purpose: 'mailbox_code',challenge_id: randomUUID(),
      mailbox_id: mailboxId },{ async allowsWithClient(client,id) { visited.push(id);return id===allowed; } });
    assert.equal(result,allowed!==null);assert.ok(visited.every(id=>entries.some(entry=>entry.tenantId===id)));
    const members=f.queries.filter(query=>query?.name==='customer-delivery-code-member-lock');
    assert.equal(members.length,allowed===null ? 0 : 1);
    if (members.length) assert.equal(members[0].values[1],allowed);
  }
});

test('fixed real delivery qualifier needs the exact live shared lease and same business transaction',async()=>{
  const business=fakePool(),lease=fakePool(),scope={ environment: 'int',securityEpoch: epoch };
  const eligibility=createPostgresProtectedRealDeliveryEligibility(business.pool,scope);
  await assert.rejects(eligibility.allowsWithClient(business.client,tenantId),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.pool,leasePool: lease.pool,...scope });
  await scopes.withShared(async()=>{
    await assert.rejects(eligibility.allowsWithClient(business.client,tenantId),/TRANSACTION_INVALID/);
    await withPostgresTransaction(business.pool,async client=>{
      assert.equal(await eligibility.allowsWithClient(client,tenantId),true);
      await assert.rejects(eligibility.allowsWithClient(lease.client,tenantId),/TRANSACTION_INVALID/);
      await assert.rejects(eligibility.allowsWithClient(client,'unknown'),/TRANSACTION_INVALID/);
    });
  });
  const query=business.queries.find(value=>value?.name==='protected-delivery-real-tenant-lock');
  assert.deepEqual(query.values,['int',epoch,tenantId]);
});

test('owned worker keeps deployment lease across the bounded provider call and settlement, with immediate local busy exclusion',async t=>{
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const recipient='Recipient@example.test',now=new Date(),message={ deliveryId: invitation.id,recipient,
    subject: 'Synthetic invitation',text: 'Synthetic isolated dispatch' };
  const payload=cipher.seal(Buffer.from(JSON.stringify(message)),{ environment: 'int',mailboxId,recordId: invitation.id,
    tenantId,purpose: 'membership_invitation' });
  const mailbox=cipher.seal(Buffer.from(recipient),{ environment: 'int',mailboxId,recordId: mailboxId,
    tenantId: null,purpose: 'mailbox_recipient' });
  const business=fakePool(value=>{
    switch (value?.name) {
      case 'customer-delivery-candidates': return { rowCount: 1,rows: [invitation] };
      case 'customer-delivery-claim-lock': return { rowCount: 1,rows: [{ ...invitation,now,
        expires_at: new Date(now.getTime()+3_600_000),attempt_count: 0,payload_envelope: payload }] };
      case 'customer-delivery-mailbox-read': return { rowCount: 1,rows: [{ mailbox_id: mailboxId,
        lookup_hash: cipher.recipientLookup(recipient),recipient_envelope: mailbox }] };
      case 'customer-delivery-settle': return { rowCount: 1,rows: [{ status: 'accepted' }] };
      default: return { rowCount: 1,rows: [] };
    }
  }),lease=fakePool();
  let enter,release,sends=0;
  const entered=new Promise(resolve=>{ enter=resolve; }),pending=new Promise(resolve=>{ release=resolve; });
  const worker=createProtectedCustomerAccessDeliveryWorker({ pool: business.pool,leasePool: lease.pool,
    environment: 'int',securityEpoch: epoch,cipher,provider: { async send(value) {
      sends++;assert.deepEqual(value,message);
      assert.equal(requireProtectedRuntimeSharedExecutionScope(business.pool,{ environment: 'int',securityEpoch: epoch }),true);
      enter();return pending;
    } } });
  const first=worker.runOnce();await entered;
  assert.equal(lease.queries.includes('COMMIT'),false);
  assert.deepEqual(await worker.runOnce(),{ status: 'busy' });assert.equal(lease.connections(),1);assert.equal(sends,1);
  release({ status: 'accepted',messageId: randomUUID() });assert.deepEqual(await first,{ status: 'accepted' });
  assert.equal(lease.queries.at(-1),'COMMIT');assert.equal(sends,1);
  assert.throws(()=>requireProtectedRuntimeSharedExecutionScope(business.pool,{ environment: 'int',securityEpoch: epoch }),
    { code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
});
