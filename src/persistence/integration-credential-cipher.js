import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';

const KEY_ID = /^[a-z][a-z0-9_]{1,31}$/;
const PROVIDER_ID = /^[a-z][a-z0-9_]{1,47}$/;
const PURPOSES = new Set(['provider_authentication', 'partner_authentication']);
const MAX_BYTES = 8192;
const SCOPE_KEYS = ['tenantId', 'integrationId', 'providerId', 'credentialId', 'version', 'purpose'];

function invalid() {
  throw new TypeError('INTEGRATION_CREDENTIAL_INVALID');
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}

function authenticatedScope(value, keyId) {
  exactRecord(value, SCOPE_KEYS);
  if (![value.tenantId, value.integrationId, value.credentialId].every(isInternalUuid)
    || typeof value.providerId !== 'string' || !PROVIDER_ID.test(value.providerId)
    || !Number.isSafeInteger(value.version) || value.version < 1 || !PURPOSES.has(value.purpose)) invalid();
  return Buffer.from(JSON.stringify([
    'conference-manager/integration-credential/v1', keyId,
    value.tenantId.toLowerCase(), value.integrationId.toLowerCase(), value.providerId,
    value.credentialId.toLowerCase(), value.version, value.purpose,
  ]), 'utf8');
}

function decode(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64url') !== value) invalid();
  return bytes;
}

// Keys are supplied only by trusted server composition, independently of encrypted database rows.
export function createIntegrationCredentialCipher({ activeKeyId, keys } = {}) {
  if (!(keys instanceof Map) || keys.size < 1 || keys.size > 8
    || typeof activeKeyId !== 'string' || !KEY_ID.test(activeKeyId) || !keys.has(activeKeyId)) invalid();
  const entries = [...keys];
  for (const [keyId, bytes] of entries) {
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId) || !Buffer.isBuffer(bytes) || bytes.length !== 32) invalid();
  }
  const keyring = new Map(entries.map(([keyId, bytes]) => [keyId, Buffer.from(bytes)]));
  let destroyed = false;
  const requireActive = () => {
    if (destroyed) throw new Error('INTEGRATION_CREDENTIAL_UNAVAILABLE');
  };

  return Object.freeze({
    seal(plaintext, scope) {
      requireActive();
      if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_BYTES) invalid();
      const aad = authenticatedScope(scope, activeKeyId);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyring.get(activeKeyId), nonce, { authTagLength: 16 });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        schemaVersion: 1,
        keyId: activeKeyId,
        nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      });
    },
    open(envelope, scope) {
      requireActive();
      exactRecord(envelope, ['schemaVersion', 'keyId', 'nonce', 'tag', 'ciphertext']);
      if (envelope.schemaVersion !== 1 || typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId)) invalid();
      const aad = authenticatedScope(scope, envelope.keyId);
      const nonce = decode(envelope.nonce, 12, 12);
      const tag = decode(envelope.tag, 16, 16);
      const ciphertext = decode(envelope.ciphertext, 1, MAX_BYTES);
      const key = keyring.get(envelope.keyId);
      if (!key) throw new Error('INTEGRATION_CREDENTIAL_UNAVAILABLE');
      let unverified;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        unverified = decipher.update(ciphertext);
        return Buffer.concat([unverified, decipher.final()]);
      } catch {
        throw new Error('INTEGRATION_CREDENTIAL_UNAVAILABLE');
      } finally {
        unverified?.fill(0);
      }
    },
    destroy() {
      destroyed = true;
      keyring.forEach((key) => key.fill(0));
      keyring.clear();
    },
  });
}
