import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeInvitationRecipient } from '../domain/invitation-recipient.js';

const KEY_ID = /^[a-z][a-z0-9_]{1,31}$/;
const PURPOSES = new Set(['mailbox_recipient', 'membership_invitation', 'mailbox_code']);
const MAX_BYTES = 32768;
function invalid() { throw new TypeError('CUSTOMER_ACCESS_CIPHERTEXT_INVALID'); }
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !fields.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function aad(value, keyId, environment) {
  record(value, ['environment', 'mailboxId', 'recordId', 'purpose', 'tenantId']);
  if (value.environment !== environment || !isInternalUuid(value.mailboxId) || !isInternalUuid(value.recordId)
    || !PURPOSES.has(value.purpose)
    || (value.purpose === 'membership_invitation' ? !isInternalUuid(value.tenantId) : value.tenantId !== null)) invalid();
  return Buffer.from(JSON.stringify(['conference-manager/customer-access/v1', keyId, environment,
    value.mailboxId.toLowerCase(), value.recordId.toLowerCase(), value.purpose, value.tenantId?.toLowerCase() ?? null]), 'utf8');
}
function decode(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64url') !== value) invalid();
  return bytes;
}

// Server-only encrypted mailbox/delivery custody. Expected scope is independently
// loaded and authorized, never obtained from the envelope or a browser payload.
export function createCustomerAccessCipher({ environment, activeKeyId, keys, lookupSecret } = {}) {
  if (!['dev', 'int', 'prod'].includes(environment) || !(keys instanceof Map) || keys.size < 1 || keys.size > 8
    || typeof activeKeyId !== 'string' || !KEY_ID.test(activeKeyId) || !keys.has(activeKeyId)
    || typeof lookupSecret !== 'string' || Buffer.byteLength(lookupSecret) < 32 || Buffer.byteLength(lookupSecret) > 512
    || /[\u0000-\u001f\u007f]/.test(lookupSecret)) invalid();
  const entries = [...keys];
  for (const [keyId, key] of entries) {
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId) || !Buffer.isBuffer(key) || key.length !== 32
      || key.equals(Buffer.from(lookupSecret))) invalid();
  }
  const keyring = new Map(entries.map(([keyId, key]) => [keyId, Buffer.from(key)]));
  const lookupKey = Buffer.from(lookupSecret, 'utf8');
  let destroyed = false;
  function requireActive() { if (destroyed) throw new Error('CUSTOMER_ACCESS_CUSTODY_UNAVAILABLE'); }
  return Object.freeze({
    recipientLookup(recipient) {
      requireActive();
      const normalized = normalizeInvitationRecipient(recipient);
      return createHmac('sha256', lookupKey).update(`customer-mailbox-lookup:v1:${environment}:${normalized}`, 'ascii').digest('hex');
    },
    commandDigest(bytes, scope) {
      requireActive(); record(scope, ['tenantId', 'commandId', 'actorType', 'actorId']);
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BYTES
        || ![scope.tenantId, scope.commandId, scope.actorId].every(isInternalUuid)
        || !['customer', 'platform'].includes(scope.actorType)) invalid();
      const binding = JSON.stringify(['customer-access-command:v1', environment, scope.tenantId.toLowerCase(),
        scope.commandId.toLowerCase(), scope.actorType, scope.actorId.toLowerCase()]);
      return createHmac('sha256', lookupKey).update(binding, 'ascii').update(Buffer.from([0])).update(bytes).digest('hex');
    },
    platformCreationDigest(bytes, scope) {
      requireActive();record(scope,['operatorId','commandId']);
      if (!Buffer.isBuffer(bytes) || bytes.length<1 || bytes.length>MAX_BYTES
        || ![scope.operatorId,scope.commandId].every(isInternalUuid)) invalid();
      const binding=JSON.stringify(['platform-customer-onboarding-command:v1',environment,
        scope.operatorId.toLowerCase(),scope.commandId.toLowerCase()]);
      return createHmac('sha256',lookupKey).update(binding,'ascii').update(Buffer.from([0])).update(bytes).digest('hex');
    },
    seal(plaintext, scope) {
      requireActive();
      if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_BYTES) invalid();
      const associatedData = aad(scope, activeKeyId, environment), nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyring.get(activeKeyId), nonce, { authTagLength: 16 });
      cipher.setAAD(associatedData);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({ schemaVersion: 1, keyId: activeKeyId, nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') });
    },
    open(envelope, scope) {
      requireActive(); record(envelope, ['schemaVersion', 'keyId', 'nonce', 'tag', 'ciphertext']);
      if (envelope.schemaVersion !== 1 || typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId)) invalid();
      const associatedData = aad(scope, envelope.keyId, environment), nonce = decode(envelope.nonce, 12, 12);
      const tag = decode(envelope.tag, 16, 16), ciphertext = decode(envelope.ciphertext, 1, MAX_BYTES);
      const key = keyring.get(envelope.keyId);
      if (!key) throw new Error('CUSTOMER_ACCESS_CUSTODY_UNAVAILABLE');
      let unverified;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        decipher.setAAD(associatedData); decipher.setAuthTag(tag);
        unverified = decipher.update(ciphertext);
        return Buffer.concat([unverified, decipher.final()]);
      } catch { throw new Error('CUSTOMER_ACCESS_CUSTODY_UNAVAILABLE'); }
      finally { unverified?.fill(0); }
    },
    destroy() { destroyed = true; keyring.forEach(key => key.fill(0)); keyring.clear(); lookupKey.fill(0); },
  });
}
