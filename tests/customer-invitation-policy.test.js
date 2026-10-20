import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCustomerInvitationBatch as normalize } from '../src/authorization/customer-invitation-policy.js';

const invite = (extra = {}) => ({ recipient: 'Person+pilot@Example.COM', roles: ['tenant_admin'], locale: 'de', ...extra });
const batch = (entries = [invite()]) => ({ commandId: 'b0000000-0000-4000-8000-000000000001', invitations: entries });

test('bounded invitation intent reuses canonical Customer roles and preserves recipient identity', () => {
  const source = batch([invite({ roles: ['tenant_admin', 'conference_manager'] }), invite({ recipient: 'person+pilot@example.com',
    roles: [], locale: 'en' }), invite({ recipient: 'Person@example.com', roles: ['conference_manager'] })]);
  const saved = JSON.stringify(source), result = normalize(source);
  assert.deepEqual(result.invitations[0], { recipient: 'Person+pilot@example.com', roles: ['conference_manager', 'tenant_admin'],
    locale: 'de' });
  assert.deepEqual(result.invitations[1].roles, []);
  assert.equal(JSON.stringify(source), saved); source.invitations[0].roles.pop();
  assert.equal(result.invitations[0].roles.length, 2);
  assert.equal(Object.isFrozen(result.invitations[0].roles), true);
  assert.equal(Object.isFrozen(result.invitations), true);
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch(JSON.stringify(result), /tenantId|userId|permission|provider|token|accepted/);
});

test('one through twenty distinct recipients are accepted; empty, duplicate and excessive batches fail', () => {
  const entries = Array.from({ length: 20 }, (_, index) => invite({ recipient: `person${index}@example.com` }));
  assert.equal(normalize(batch(entries)).invitations.length, 20);
  for (const source of [batch([]), batch([...entries, invite()]), batch([invite(), invite()]),
    batch([invite(), invite({ recipient: 'Person+pilot@example.com' })])]) assert.throws(() => normalize(source), /INVALID/);
});

test('Platform authority, baseline roles, duplicates and unknown permissions cannot be invitation intent', () => {
  for (const roles of [['platform_admin'], ['security_admin'], ['tenant_operator'], ['employee'],
    ['tenant_admin', 'tenant_admin'], ['tenant:users:manage'], [null], [42], ['tenant_admin', 'conference_manager', 'employee']]) {
    assert.throws(() => normalize(batch([invite({ roles })])), /INVALID/);
  }
  for (const extra of [{ tenantId: 'selected' }, { userId: 'selected' }, { provider: 'microsoft' }, { accepted: true },
    { expiresAt: '2099-01-01' }, { permissions: [] }, { locale: 'fr' }, { locale: null }, { recipient: ' Name@example.com' },
    { recipient: 'Name <person@example.com>' }, { recipient: 'person@example.com\r\nBcc: other@example.com' }]) {
    assert.throws(() => normalize(batch([invite(extra)])), /INVALID/);
  }
  assert.throws(() => normalize({ ...batch(), tenantId: 'selected' }), /INVALID/);
  assert.throws(() => normalize({ ...batch(), commandId: '../foreign' }), /INVALID/);
  assert.throws(() => normalize({ invitations: [invite()] }), /INVALID/);
});

test('sparse, accessor, hidden, symbol and prototype-bearing structures fail without evaluating getters', () => {
  let reads = 0;
  const accessor = invite(); Object.defineProperty(accessor, 'recipient', { enumerable: true, get() { reads++; return 'x@y.com'; } });
  const hidden = invite(); Object.defineProperty(hidden, 'private', { value: 'private' });
  const symbol = invite(); symbol[Symbol('private')] = true;
  const accessorArray = [invite()]; Object.defineProperty(accessorArray, '0', { enumerable: true, get() { reads++; return invite(); } });
  const roles = ['tenant_admin']; Object.defineProperty(roles, '0', { enumerable: true, get() { reads++; return 'tenant_admin'; } });
  for (const value of [batch(Array(1)), batch([accessor]), batch([hidden]), batch([symbol]), batch(accessorArray),
    batch([invite({ roles })]), Object.create(batch()), batch([Object.create(invite())])]) {
    assert.throws(() => normalize(value), /INVALID/);
  }
  assert.equal(reads, 0);
});
