import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { requirePlatformPasskeyBrowserRecipient } from '../scripts/support/platform-passkey-browser-recipient.mjs';

const origin = 'https://ops-int.example.com', now = Date.now();
const key = generateKeyPairSync('rsa', { modulusLength: 4096 }).publicKey;
const request = { format: 'cm-int-passkey-recipient:v1', origin, requestId: randomUUID(),
  recipientPublicKey: key.export({ type: 'spki', format: 'pem' }),
  recipientSha256: createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'),
  createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString() };

test('public recipient validation returns only delivery bindings, never identity or approval authority', () => {
  const result = requirePlatformPasskeyBrowserRecipient(JSON.stringify(request), { expectedOrigin: origin, now });
  assert.deepEqual(result, { correlationId: request.requestId, recipientPublicKey: request.recipientPublicKey,
    recipientSha256: request.recipientSha256 });
  assert.ok(Object.isFrozen(result));
});

test('foreign origin, stale/future/ambiguous request, weak key and fingerprint mismatch fail before an issuer', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  for (const patch of [{ origin: 'https://foreign.example.com' }, { requestId: 'not-a-uuid' }, { unknown: true },
    { operatorId: randomUUID() }, { recipientSha256: '0'.repeat(64) }, { recipientPublicKey: 'private-data' },
    { recipientPublicKey: weak.export({ type: 'spki', format: 'pem' }),
      recipientSha256: createHash('sha256').update(weak.export({ type: 'spki', format: 'der' })).digest('hex') },
    { createdAt: new Date(now + 60001).toISOString(), expiresAt: new Date(now + 960001).toISOString() },
    { createdAt: new Date(now - 840000).toISOString(), expiresAt: new Date(now + 60000).toISOString() },
    { expiresAt: new Date(now + 900001).toISOString() }]) {
    assert.throws(() => requirePlatformPasskeyBrowserRecipient(JSON.stringify({ ...request, ...patch }),
      { expectedOrigin: origin, now }), { message: 'PLATFORM_PASSKEY_BROWSER_RECIPIENT_REJECTED' });
  }
  for (const value of ['{', 'x'.repeat(4097), 'null']) {
    assert.throws(() => requirePlatformPasskeyBrowserRecipient(value, { expectedOrigin: origin, now }));
  }
});
