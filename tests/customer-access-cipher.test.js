import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';

const id = number => `b0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const lookupSecret = 'synthetic-mailbox-lookup-key-test-only-00001';
const configuration = extra => ({ environment: 'int', activeKeyId: 'first', keys: new Map([['first', Buffer.alloc(32, 1)]]),
  lookupSecret, ...extra });
const scope = (extra = {}) => ({ environment: 'int', mailboxId: id(1), recordId: id(2),
  purpose: 'mailbox_code', tenantId: null, ...extra });
const plaintext = Buffer.from('Synthetic recipient and code: 00001234', 'utf8');

test('real AES-GCM protects copied mailbox/delivery bytes with random nonces and a closed non-secret envelope', () => {
  const cipher = createCustomerAccessCipher(configuration());
  const first = cipher.seal(plaintext, scope()), second = cipher.seal(plaintext, scope());
  assert.equal(Object.isFrozen(first), true); assert.notEqual(first.nonce, second.nonce);
  assert.deepEqual(cipher.open(first, scope()), plaintext);
  assert.doesNotMatch(JSON.stringify(first), /Synthetic|00001234|recipient|mailboxId|tenantId/);
  for (const purpose of ['mailbox_recipient', 'membership_invitation']) {
    const target = scope({ purpose, tenantId: purpose === 'membership_invitation' ? id(3) : null });
    assert.deepEqual(cipher.open(cipher.seal(plaintext, target), target), plaintext);
  }
  const bytes = Buffer.alloc(32768, 4); assert.deepEqual(cipher.open(cipher.seal(bytes, scope()), scope()), bytes);
  for (const value of [Buffer.alloc(0), Buffer.alloc(32769), 'private']) assert.throws(() => cipher.seal(value, scope()));
});

test('mailbox, record, purpose, Tenant, environment, key, tag and ciphertext substitutions cannot authenticate', () => {
  const cipher = createCustomerAccessCipher(configuration()), binding = scope({ purpose: 'membership_invitation', tenantId: id(3) });
  const envelope = cipher.seal(plaintext, binding);
  for (const extra of [{ mailboxId: id(4) }, { recordId: id(4) }, { tenantId: id(4) }, { purpose: 'mailbox_code', tenantId: null }]) {
    assert.throws(() => cipher.open(envelope, { ...binding, ...extra }), /UNAVAILABLE/);
  }
  assert.throws(() => cipher.open(envelope, { ...binding, environment: 'prod' }), /INVALID/);
  for (const field of ['nonce', 'tag', 'ciphertext']) {
    const bytes = Buffer.from(envelope[field], 'base64url'); bytes[0] ^= 1;
    assert.throws(() => cipher.open({ ...envelope, [field]: bytes.toString('base64url') }, binding), /UNAVAILABLE/);
  }
  assert.throws(() => createCustomerAccessCipher(configuration({ keys: new Map([['first', Buffer.alloc(32, 2)]]) }))
    .open(envelope, binding), /UNAVAILABLE/);
  for (const extra of [{ private: true }, { schemaVersion: 2 }, { nonce: `${envelope.nonce}=` }, { keyId: 'unknown' }]) {
    assert.throws(() => cipher.open({ ...envelope, ...extra }, binding));
  }
  assert.throws(() => cipher.open(envelope, scope({ tenantId: id(3) })), /INVALID/);
  assert.throws(() => cipher.open(envelope, { ...binding, browser: true }), /INVALID/);
});

test('recipient fingerprints are deployment-separated and preserve case/plus/dot identity without storing plaintext', () => {
  const cipher = createCustomerAccessCipher(configuration()), first = cipher.recipientLookup('Person+pilot@EXAMPLE.COM');
  assert.match(first, /^[a-f0-9]{64}$/); assert.equal(first, cipher.recipientLookup('Person+pilot@example.com'));
  for (const recipient of ['person+pilot@example.com', 'Person@example.com', 'Per.son+pilot@example.com']) {
    assert.notEqual(first, cipher.recipientLookup(recipient));
  }
  assert.notEqual(first, createCustomerAccessCipher(configuration({ environment: 'prod' })).recipientLookup('Person+pilot@example.com'));
  assert.notEqual(first, createCustomerAccessCipher(configuration({ lookupSecret: `${lookupSecret}-other` }))
    .recipientLookup('Person+pilot@example.com'));
  assert.throws(() => cipher.recipientLookup('Name <person@example.com>'));
});

test('trusted key rotation, caller mutation isolation, retirement and destruction fail closed', () => {
  const key = Buffer.alloc(32, 1), keys = new Map([['first', key]]), cipher = createCustomerAccessCipher(configuration({ keys }));
  const envelope = cipher.seal(plaintext, scope()); key.fill(9); keys.clear();
  assert.deepEqual(cipher.open(envelope, scope()), plaintext);
  const rotated = createCustomerAccessCipher(configuration({ activeKeyId: 'second',
    keys: new Map([['first', Buffer.alloc(32, 1)], ['second', Buffer.alloc(32, 2)]]) }));
  assert.deepEqual(rotated.open(envelope, scope()), plaintext);
  assert.equal(rotated.seal(plaintext, scope()).keyId, 'second');
  assert.throws(() => createCustomerAccessCipher(configuration({ activeKeyId: 'second', keys: new Map([['second', Buffer.alloc(32, 2)]]) }))
    .open(envelope, scope()), /UNAVAILABLE/);
  cipher.destroy(); cipher.destroy();
  for (const invoke of [() => cipher.seal(plaintext, scope()), () => cipher.open(envelope, scope()),
    () => cipher.recipientLookup('person@example.com')]) assert.throws(invoke, /UNAVAILABLE/);
});

test('invalid key custody and accessor/prototype-bearing envelopes/scopes are rejected without getter execution', () => {
  for (const extra of [{ environment: 'demo' }, { lookupSecret: 'short' }, { activeKeyId: 'unknown' }, { keys: new Map() },
    { keys: new Map([['first', Buffer.alloc(31)]]) },
    { lookupSecret: 'x'.repeat(32), keys: new Map([['first', Buffer.alloc(32, 120)]]) }]) {
    assert.throws(() => createCustomerAccessCipher(configuration(extra)), /INVALID/);
  }
  let reads = 0; const cipher = createCustomerAccessCipher(configuration()), envelope = cipher.seal(plaintext, scope());
  const accessor = { ...envelope };
  Object.defineProperty(accessor, 'tag', { enumerable: true, get() { reads++; return envelope.tag; } });
  assert.throws(() => cipher.open(accessor, scope()), /INVALID/);
  assert.throws(() => cipher.open(Object.create(envelope), scope()), /INVALID/);
  const unsafeScope = scope();
  Object.defineProperty(unsafeScope, 'mailboxId', { enumerable: true, get() { reads++; return id(1); } });
  assert.throws(() => cipher.seal(plaintext, unsafeScope), /INVALID/); assert.equal(reads, 0);
});

test('command receipts use a separate keyed digest bound to exact actor, Tenant, environment, command and payload', () => {
  const cipher = createCustomerAccessCipher(configuration());
  const binding = { tenantId: id(1), commandId: id(2), actorType: 'customer', actorId: id(3) };
  const digest = cipher.commandDigest(plaintext, binding); assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(cipher.commandDigest(Buffer.from(plaintext), binding), digest);
  for (const extra of [{ tenantId: id(4) }, { commandId: id(4) }, { actorId: id(4) }, { actorType: 'platform' }]) {
    assert.notEqual(cipher.commandDigest(plaintext, { ...binding, ...extra }), digest);
  }
  assert.notEqual(cipher.commandDigest(Buffer.from('changed payload'), binding), digest);
  assert.notEqual(createCustomerAccessCipher(configuration({ environment: 'prod' })).commandDigest(plaintext, binding), digest);
  for (const extra of [{ actorType: 'unknown' }, { tenantId: 'invalid' }, { private: true }]) {
    assert.throws(() => cipher.commandDigest(plaintext, { ...binding, ...extra }), /INVALID/);
  }
  cipher.destroy(); assert.throws(() => cipher.commandDigest(plaintext, binding), /UNAVAILABLE/);
});
