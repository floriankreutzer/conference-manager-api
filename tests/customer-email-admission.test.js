import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesCustomerEmailAdmission, normalizeCustomerEmailAdmissionSnapshot } from '../src/identity/customer-email-admission.js';

const id = number => `e0000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const pending = (extra = {}) => ({ membershipId: id(1),tenantId: id(2),userId: null,userSecurityVersion: null,
  invitationId: id(3),invitationRevision: 1,...extra });
const accepted = (extra = {}) => pending({ userId: id(4),userSecurityVersion: 2,invitationId: null,invitationRevision: null,...extra });

test('server-loaded admission snapshots are copied, bounded and contain no roles or mailbox authority', () => {
  const first = pending(), second = accepted({ membershipId: id(5),tenantId: id(6) });
  const result = normalizeCustomerEmailAdmissionSnapshot([first,second]);
  first.invitationRevision = 4;
  assert.equal(result[0].invitationRevision,1); assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result[0]),true);
  assert.equal(matchesCustomerEmailAdmission({ snapshot: result,current: pending() }),true);
  assert.equal(matchesCustomerEmailAdmission({ snapshot: result,current: second }),true);
  assert.doesNotMatch(JSON.stringify(result),/roles|permissions|recipient|mailbox|session|code|token/);
  assert.deepEqual(normalizeCustomerEmailAdmissionSnapshot([]),[]);
});

test('new membership, Tenant substitution, reissue, acceptance, changed User and changed security version invalidate old proof', () => {
  for (const current of [pending({ membershipId: id(8) }),pending({ tenantId: id(8) }),
    pending({ invitationId: id(8) }),pending({ invitationRevision: 2 }),accepted()]) {
    assert.equal(matchesCustomerEmailAdmission({ snapshot: [pending()],current }),false);
  }
  for (const current of [accepted({ userId: id(8) }),accepted({ userSecurityVersion: 3 }),pending()]) {
    assert.equal(matchesCustomerEmailAdmission({ snapshot: [accepted()],current }),false);
  }
  assert.equal(matchesCustomerEmailAdmission({ snapshot: [],current: pending() }),false);
});

test('mixed or malformed proof snapshots fail closed without reading accessors', () => {
  let reads = 0; const accessor = pending();
  Object.defineProperty(accessor,'userId',{ enumerable: true,get() { reads++; return null; } });
  for (const value of [pending({ userSecurityVersion: 1 }),pending({ invitationRevision: null }),
    accepted({ invitationId: id(3) }),accepted({ userSecurityVersion: 0 }),accepted({ userSecurityVersion: Number.MAX_SAFE_INTEGER }),
    pending({ roles: ['tenant_admin'] }),accessor,Object.create(pending())]) {
    assert.throws(() => normalizeCustomerEmailAdmissionSnapshot([value]),/ADMISSION_INVALID/);
  }
  for (const value of [Array(1),[pending(),pending()],[pending(),accepted({ membershipId: id(8) })],
    Array.from({ length: 101 },(_,index) => pending({ membershipId: id(index+10),tenantId: id(index+200) }))]) {
    assert.throws(() => normalizeCustomerEmailAdmissionSnapshot(value),/ADMISSION_INVALID/);
  }
  assert.equal(reads,0);
});
