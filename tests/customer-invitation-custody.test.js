import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerInvitationCustody } from '../src/persistence/postgres/customer-invitation-custody.js';

const id='d6000000-0000-4000-8000-000000000001';
test('shared invitation custody requires the caller transaction before any read, ciphertext, audit or queue effect',async () => {
  let effects=0;
  const effect=() => { effects++;throw new Error('UNEXPECTED_EFFECT'); };
  const pool={ connect: effect },client={ query: effect };
  const custody=createCustomerInvitationCustody(pool,{ environment: 'int',
    cipher: { seal: effect,open: effect,recipientLookup: effect },content: { invitation: effect },identifierFactory: effect });
  await assert.rejects(custody.load(client,id,id),/CUSTOMER_INVITATION_TRANSACTION_REQUIRED/);
  await assert.rejects(custody.delivery(client,{ tenantId: id }),/CUSTOMER_INVITATION_TRANSACTION_REQUIRED/);
  await assert.rejects(custody.issue(client,{ tenantId: id,recordAudit: effect }),/CUSTOMER_INVITATION_TRANSACTION_REQUIRED/);
  assert.equal(effects,0);
});
