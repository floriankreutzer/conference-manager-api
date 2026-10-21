import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
const ORIGIN = 'https://ops-int.example.com';
const RP_ID = 'ops-int.example.com';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const encoded = (value) => Buffer.from(value).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest();

export function platformPasskeyFixture({ operatorId = OPERATOR } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const id = randomBytes(32);
  const challenge = randomBytes(32).toString('base64url');
  const userHandle = randomBytes(32).toString('base64url');
  const credential = { id: encoded(id), publicKey: encoded(cose), counter: 0,
    backupEligible: false, operatorId, environment: 'int', userHandle };

  function response(purpose, changes = {}) {
    const data = Buffer.from(JSON.stringify({ type: purpose === 'create' ? 'webauthn.create' : 'webauthn.get',
      origin: ORIGIN, challenge, crossOrigin: false, ...changes.client }));
    const count = Buffer.alloc(4);
    count.writeUInt32BE(changes.counter ?? (purpose === 'create' ? 0 : 1));
    const flags = Buffer.from([changes.flags ?? (purpose === 'create' ? 0x45 : 0x05)]);
    const prefix = [hash(changes.rpId || RP_ID), flags, count];
    const envelope = { id: encoded(id), rawId: encoded(id), type: 'public-key', clientExtensionResults: {} };
    if (purpose === 'create') {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([...prefix, Buffer.alloc(16), length, id, cose]);
      return { ...envelope, response: { clientDataJSON: encoded(data), transports: ['internal'],
        attestationObject: encoded(isoCBOR.encode(new Map([
          ['fmt', changes.fmt || 'none'], ['attStmt', changes.attStmt || new Map()], ['authData', authData],
        ]))) } };
    }
    const authData = Buffer.concat(prefix);
    const signature = sign('sha256', Buffer.concat([authData, hash(data)]), privateKey);
    return { ...envelope, response: { clientDataJSON: encoded(data), authenticatorData: encoded(authData),
      signature: encoded(signature), userHandle } };
  }
  return { credential, challenge, userHandle, response,
    // Ephemeral test material only, for importing this same generated key into
    // Chromium's native virtual authenticator. Never logged or persisted.
    exportPrivateKey: () => privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

