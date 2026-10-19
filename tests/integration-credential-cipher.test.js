import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrationCredentialCipher } from '../src/persistence/integration-credential-cipher.js';

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const scope = () => ({
  tenantId: 'a0000000-0000-4000-8000-000000000001', integrationId: id(2), providerId: 'reference_caterer',
  credentialId: id(3), version: 1, purpose: 'provider_authentication',
});
const fixtureKey = (value = 1) => Buffer.alloc(32, value);
const cipher = () => createIntegrationCredentialCipher({ activeKeyId: 'primary', keys: new Map([['primary', fixtureKey()]]) });
const flip = (value) => {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
};

test('authenticated encryption round trips opaque bytes with a fresh nonce and immutable minimized envelope', () => {
  const vault = cipher();
  const input = Buffer.from([0, 1, 127, 255]);
  const first = vault.seal(input, scope());
  const second = vault.seal(input, scope());
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(Object.keys(first).sort(), ['ciphertext', 'keyId', 'nonce', 'schemaVersion', 'tag']);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(vault.open(first, scope()), input);
  assert.deepEqual(vault.open(second, scope()), input);
  assert.deepEqual(vault.open(first, { ...scope(), tenantId: scope().tenantId.toUpperCase() }), input);
  assert.equal(JSON.stringify(first).includes(scope().tenantId), false);
  assert.equal(JSON.stringify(first).includes(scope().providerId), false);
  vault.destroy();
});

test('ciphertext cannot move between Tenant, Integration, provider, credential, version or purpose', () => {
  const vault = cipher();
  const sealed = vault.seal(Buffer.from('synthetic fixture bytes'), scope());
  for (const changed of [
    { tenantId: id(9) }, { integrationId: id(9) }, { providerId: 'other_caterer' },
    { credentialId: id(9) }, { version: 2 }, { purpose: 'partner_authentication' },
  ]) assert.throws(() => vault.open(sealed, { ...scope(), ...changed }), /INTEGRATION_CREDENTIAL_UNAVAILABLE/);
  assert.deepEqual(vault.open(sealed, scope()), Buffer.from('synthetic fixture bytes'));
  vault.destroy();
});

test('tampered bytes, wrong keys and key-ID aliases fail authentication without exposing provider bytes', () => {
  const vault = cipher();
  const sealed = vault.seal(Buffer.from('synthetic fixture bytes'), scope());
  for (const field of ['nonce', 'tag', 'ciphertext']) {
    assert.throws(() => vault.open({ ...sealed, [field]: flip(sealed[field]) }, scope()),
      { message: 'INTEGRATION_CREDENTIAL_UNAVAILABLE' });
  }
  const wrong = createIntegrationCredentialCipher({ activeKeyId: 'primary', keys: new Map([['primary', fixtureKey(2)]]) });
  assert.throws(() => wrong.open(sealed, scope()), { message: 'INTEGRATION_CREDENTIAL_UNAVAILABLE' });
  const alias = createIntegrationCredentialCipher({
    activeKeyId: 'primary', keys: new Map([['primary', fixtureKey()], ['alias', fixtureKey()]]),
  });
  assert.throws(() => alias.open({ ...sealed, keyId: 'alias' }, scope()), /INTEGRATION_CREDENTIAL_UNAVAILABLE/);
  assert.throws(() => vault.open({ ...sealed, keyId: 'unknown' }, scope()), /INTEGRATION_CREDENTIAL_UNAVAILABLE/);
  vault.destroy(); wrong.destroy(); alias.destroy();
});

test('rotation reads retained keys, writes only the active key and rejects retired material', () => {
  const previous = cipher();
  const value = Buffer.from('synthetic fixture bytes');
  const old = previous.seal(value, scope());
  const rotated = createIntegrationCredentialCipher({
    activeKeyId: 'next_key', keys: new Map([['primary', fixtureKey()], ['next_key', fixtureKey(2)]]),
  });
  const plaintext = rotated.open(old, scope());
  const replacement = rotated.seal(plaintext, scope());
  plaintext.fill(0);
  assert.equal(replacement.keyId, 'next_key');
  assert.deepEqual(rotated.open(replacement, scope()), value);
  const retired = createIntegrationCredentialCipher({ activeKeyId: 'next_key', keys: new Map([['next_key', fixtureKey(2)]]) });
  assert.throws(() => retired.open(old, scope()), /INTEGRATION_CREDENTIAL_UNAVAILABLE/);
  assert.deepEqual(retired.open(replacement, scope()), value);
  previous.destroy(); rotated.destroy(); retired.destroy();
});

test('key snapshots survive caller mutation and shutdown cannot be used to reopen or encrypt', () => {
  const source = fixtureKey();
  const keys = new Map([['primary', source]]);
  const vault = createIntegrationCredentialCipher({ activeKeyId: 'primary', keys });
  source.fill(0); keys.clear();
  const sealed = vault.seal(Buffer.from('fixture'), scope());
  const independent = cipher();
  assert.deepEqual(independent.open(sealed, scope()), Buffer.from('fixture'));
  vault.destroy(); vault.destroy();
  assert.throws(() => vault.open(sealed, scope()), /INTEGRATION_CREDENTIAL_UNAVAILABLE/);
  assert.throws(() => vault.seal(Buffer.from('fixture'), scope()), /INTEGRATION_CREDENTIAL_UNAVAILABLE/);
  independent.destroy();
});

test('plaintext, encoded envelopes and keyrings have closed formats and strict resource bounds', () => {
  const vault = cipher();
  for (const length of [1, 8192]) {
    const input = Buffer.alloc(length, 7);
    assert.deepEqual(vault.open(vault.seal(input, scope()), scope()), input);
  }
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(8193), 'fixture', null, new Uint8Array(8)]) {
    assert.throws(() => vault.seal(invalid, scope()), /INTEGRATION_CREDENTIAL_INVALID/);
  }
  const sealed = vault.seal(Buffer.from('fixture'), scope());
  for (const changed of [
    { schemaVersion: 2 }, { keyId: 'https://other.test' }, { nonce: '' }, { nonce: sealed.nonce + '=' },
    { tag: sealed.tag + '=' }, { tag: 'a'.repeat(24) }, { ciphertext: 'a'.repeat(12000) },
    { ciphertext: '*' }, { ciphertext: '' }, { authorized: true },
  ]) assert.throws(() => vault.open({ ...sealed, ...changed }, scope()), /INTEGRATION_CREDENTIAL_INVALID/);
  for (const keys of [new Map(), new Map([['primary', Buffer.alloc(31)]]),
    new Map([['primary', 'fixture']]), new Map(Array.from({ length: 9 }, (_, i) => [`key_${i}`, fixtureKey()]))]) {
    assert.throws(() => createIntegrationCredentialCipher({ activeKeyId: 'primary', keys }), /INTEGRATION_CREDENTIAL_INVALID/);
  }
  vault.destroy();
});

test('scope and envelopes reject accessors, symbols, prototypes and hidden properties before reading them', () => {
  const vault = cipher();
  let reads = 0;
  const accessor = { ...scope() };
  Object.defineProperty(accessor, 'tenantId', { enumerable: true, get() { reads += 1; return id(1); } });
  for (const invalid of [accessor, { ...scope(), role: 'admin' }, Object.create(scope()),
    { ...scope(), [Symbol('scope')]: true }, Object.defineProperty(scope(), 'hidden', { value: true }),
    { ...scope(), version: 0 }, { ...scope(), version: Number.MAX_SAFE_INTEGER + 1 },
    { ...scope(), purpose: 'unknown' }, { ...scope(), providerId: 'arbitrary.example' }]) {
    assert.throws(() => vault.seal(Buffer.from('fixture'), invalid), /INTEGRATION_CREDENTIAL_INVALID/);
  }
  assert.equal(reads, 0);
  const envelope = vault.seal(Buffer.from('fixture'), scope());
  const getter = { ...envelope };
  Object.defineProperty(getter, 'ciphertext', { enumerable: true, get() { reads += 1; return envelope.ciphertext; } });
  assert.throws(() => vault.open(getter, scope()), /INTEGRATION_CREDENTIAL_INVALID/);
  assert.equal(reads, 0);
  vault.destroy();
});
