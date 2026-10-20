import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCustomerMicrosoftAdmissionSnapshot,matchesCustomerMicrosoftAdmission }
  from '../src/identity/customer-microsoft-admission.js';
const id=n=>`b3000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const entry={ membershipId: id(1),tenantId: id(2),userId: id(3),userSecurityVersion: 4 };
test('Microsoft admission snapshot binds only accepted internal membership/User/security state',()=>{
  const snapshot=normalizeCustomerMicrosoftAdmissionSnapshot([entry]);assert.equal(Object.isFrozen(snapshot),true);
  assert.equal(matchesCustomerMicrosoftAdmission({ snapshot,current: entry }),true);
  for (const current of [{ ...entry,membershipId: id(4) },{ ...entry,tenantId: id(4) },
    { ...entry,userId: id(4) },{ ...entry,userSecurityVersion: 5 }]) {
    assert.equal(matchesCustomerMicrosoftAdmission({ snapshot,current }),false);
  }
  assert.deepEqual(normalizeCustomerMicrosoftAdmissionSnapshot([]),[]);
});
test('pending invitation/JIT authority, email/provider claims and duplicate or unbounded snapshots fail closed',()=>{
  for (const value of [[{ ...entry,userId: null }],[{ ...entry,invitationId: id(4) }],[{ ...entry,email: 'Untrusted@example.test' }],
    [{ ...entry,roles: ['tenant_admin'] }],[{ ...entry,userSecurityVersion: 0 }],[entry,entry],
    [entry,{ ...entry,membershipId: id(4) }],Array(1),Array(101).fill(entry)]) {
    assert.throws(()=>normalizeCustomerMicrosoftAdmissionSnapshot(value),/ADMISSION_INVALID/);
  }
});
