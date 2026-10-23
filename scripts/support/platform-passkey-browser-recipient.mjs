import { createHash, createPublicKey } from 'node:crypto';

// Public recipient metadata only. It is not identity, owner approval, database
// authority or proof of an iPhone. Resolve those independently before issuance.
export function requirePlatformPasskeyBrowserRecipient(text, { expectedOrigin, now = Date.now() } = {}) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4096 || !Number.isSafeInteger(now)) throw new Error();
    const value = JSON.parse(text), keys = ['format', 'origin', 'requestId', 'recipientPublicKey', 'recipientSha256',
      'createdAt', 'expiresAt'];
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')
      || value.format !== 'cm-int-passkey-recipient:v1' || value.origin !== expectedOrigin
      || new URL(expectedOrigin).origin !== expectedOrigin || new URL(expectedOrigin).protocol !== 'https:'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId)) throw new Error();
    const created = Date.parse(value.createdAt), expires = Date.parse(value.expiresAt);
    if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires)
      || new Date(created).toISOString() !== value.createdAt || new Date(expires).toISOString() !== value.expiresAt
      || expires - created !== 900000 || created > now + 60000 || expires <= now + 60000) throw new Error();
    const pem = value.recipientPublicKey;
    if (typeof pem !== 'string' || pem.length > 900
      || !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/.test(pem)) throw new Error();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 4096
      || key.asymmetricKeyDetails.publicExponent !== 65537n) throw new Error();
    const fingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    if (fingerprint !== value.recipientSha256) throw new Error();
    return Object.freeze({ correlationId: value.requestId, recipientPublicKey: pem, recipientSha256: fingerprint });
  } catch { throw new Error('PLATFORM_PASSKEY_BROWSER_RECIPIENT_REJECTED'); }
}
