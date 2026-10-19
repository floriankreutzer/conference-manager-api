import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createPlatformPasskeyVerifier, PlatformPasskeyError } from '../src/platform/identity/passkey-verifier.js';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const ORIGIN = 'https://ops-int.example.com';
const RP_ID = 'ops-int.example.com';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const factory = () => createPlatformPasskeyVerifier({ publicOrigin: ORIGIN, environment: 'int' });
const encoded = (value) => Buffer.from(value).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest();

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const id = randomBytes(32);
  const challenge = randomBytes(32).toString('base64url');
  const userHandle = randomBytes(32).toString('base64url');
  const credential = { id: encoded(id), publicKey: encoded(cose), counter: 0,
    backupEligible: false, operatorId: OPERATOR, environment: 'int', userHandle };

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
  return { credential, challenge, userHandle, response };
}

test('server options require user verification, exact Platform RP, discoverable credentials and bounded credential lists', async () => {
  const verifier = factory();
  const f = fixture();
  const options = await verifier.registrationOptions({ challenge: f.challenge, userHandle: f.userHandle,
    userName: 'Operator', excludeCredentialIds: [f.credential.id] });
  assert.equal(options.challenge, f.challenge);
  assert.equal(options.user.id, f.userHandle);
  assert.deepEqual(options.rp, { name: 'Conference Manager INT', id: RP_ID });
  assert.equal(options.attestation, 'none');
  assert.deepEqual(options.pubKeyCredParams, [{ alg: -7, type: 'public-key' }]);
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.equal(options.authenticatorSelection.residentKey, 'required');
  assert.equal(options.timeout, 120_000);
  const authentication = await verifier.authenticationOptions({ challenge: f.challenge,
    allowedCredentialIds: [f.credential.id] });
  assert.equal(authentication.challenge, f.challenge);
  assert.equal(authentication.rpId, RP_ID);
  assert.equal(authentication.userVerification, 'required');
  assert.equal(authentication.allowCredentials.length, 1);
  assert.equal(Buffer.from(verifier.createChallenge(), 'base64url').length, 32);
  assert.notEqual(verifier.createChallenge(), verifier.createChallenge());
});

test('real ES256 registration and signed assertion verify without granting a session or accepting browser authority', async () => {
  const verifier = factory();
  const f = fixture();
  const registration = await verifier.verifyRegistration({ response: f.response('create'), expectedChallenge: f.challenge });
  assert.deepEqual(registration, { id: f.credential.id, publicKey: f.credential.publicKey,
    counter: 0, backupEligible: false, backedUp: false });
  assert.equal(Object.isFrozen(registration), true);
  const result = await verifier.verifyAuthentication({ response: f.response('get'), expectedChallenge: f.challenge,
    expectedOperatorId: OPERATOR, credential: f.credential });
  assert.deepEqual(result, { credentialId: f.credential.id, newCounter: 1, backupEligible: false, backedUp: false });
  assert.equal(Object.hasOwn(result, 'assurance'), false);
  assert.equal(Object.hasOwn(result, 'setCookie'), false);
});

test('valid signatures from a wrong origin, RP, challenge, ceremony or cross-origin frame are rejected', async () => {
  const verifier = factory();
  const f = fixture();
  for (const changes of [{ client: { origin: 'https://evil.example' } }, { rpId: 'example.com' },
    { client: { challenge: verifier.createChallenge() } }, { client: { type: 'webauthn.create' } },
    { client: { crossOrigin: true, topOrigin: 'https://evil.example' } }, { client: { topOrigin: ORIGIN } },
    { flags: 0x01 }, { flags: 0x04 }]) {
    await assert.rejects(verifier.verifyAuthentication({ response: f.response('get', changes), expectedChallenge: f.challenge,
      expectedOperatorId: OPERATOR, credential: f.credential }), /PLATFORM_PASSKEY_REJECTED/);
  }
  for (const changes of [{ client: { origin: 'https://evil.example' } }, { rpId: 'example.com' },
    { client: { challenge: verifier.createChallenge() } }, { flags: 0x41 }, { flags: 0x44 }]) {
    await assert.rejects(verifier.verifyRegistration({ response: f.response('create', changes),
      expectedChallenge: f.challenge }), /PLATFORM_PASSKEY_REJECTED/);
  }
});

test('tampered signatures, changed ownership/environment/key, user handles and non-increasing counters fail closed', async () => {
  const verifier = factory();
  const f = fixture();
  for (const change of [{ operatorId: OTHER }, { environment: 'prod' }, { publicKey: fixture().credential.publicKey },
    { counter: 1 }, { counter: -1 }, { counter: 0x100000000 }, { userHandle: verifier.createChallenge() }]) {
    await assert.rejects(verifier.verifyAuthentication({ response: f.response('get'), expectedChallenge: f.challenge,
      expectedOperatorId: OPERATOR, credential: { ...f.credential, ...change } }), /PLATFORM_PASSKEY_REJECTED/);
  }
  const response = f.response('get');
  const signature = Buffer.from(response.response.signature, 'base64url');
  signature[signature.length - 1] ^= 1;
  response.response.signature = encoded(signature);
  await assert.rejects(verifier.verifyAuthentication({ response, expectedChallenge: f.challenge,
    expectedOperatorId: OPERATOR, credential: f.credential }), PlatformPasskeyError);
});

test('zero counters and backed-up passkeys are supported without claiming that the adapter prevents durable replay', async () => {
  const verifier = factory();
  const f = fixture();
  const zero = await verifier.verifyAuthentication({ response: f.response('get', { counter: 0 }), expectedChallenge: f.challenge,
    expectedOperatorId: OPERATOR, credential: f.credential });
  assert.equal(zero.newCounter, 0);
  const registration = await verifier.verifyRegistration({ response: f.response('create', { flags: 0x5d }),
    expectedChallenge: f.challenge });
  assert.equal(registration.backupEligible, true);
  assert.equal(registration.backedUp, true);
  await assert.rejects(verifier.verifyAuthentication({ response: f.response('get', { flags: 0x1d }),
    expectedChallenge: f.challenge, expectedOperatorId: OPERATOR, credential: f.credential }), /PLATFORM_PASSKEY_REJECTED/);
  const synced = await verifier.verifyAuthentication({ response: f.response('get', { flags: 0x1d }),
    expectedChallenge: f.challenge, expectedOperatorId: OPERATOR, credential: { ...f.credential, backupEligible: true } });
  assert.equal(synced.backedUp, true);
});

test('unrequested attestation and oversized payloads fail without outbound access or raw errors', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('synthetic-sensitive-payload'); });
  const verifier = factory();
  const f = fixture();
  for (const response of [f.response('create', { fmt: 'packed', attStmt: new Map([['x5c', [Buffer.alloc(20)]]]) }),
    { ...f.response('create'), roles: ['platform_admin'] },
    { ...f.response('create'), clientExtensionResults: { unrequested: true } },
    { ...f.response('create'), response: { clientDataJSON: 'a'.repeat(5000), attestationObject: 'invalid' } }]) {
    await assert.rejects(verifier.verifyRegistration({ response, expectedChallenge: f.challenge }), (error) => {
      assert.equal(error.code, 'PLATFORM_PASSKEY_REJECTED');
      assert.equal(error.cause, undefined);
      assert.equal(String(error).includes('synthetic-sensitive'), false);
      return true;
    });
  }
  assert.equal(calls, 0);
  for (const allowedCredentialIds of [[], [f.credential.id, f.credential.id], Array(6).fill(f.credential.id), ['a=']]) {
    await assert.rejects(verifier.authenticationOptions({ challenge: f.challenge, allowedCredentialIds }), /PLATFORM_PASSKEY_REJECTED/);
  }
  for (const publicOrigin of ['http://ops.example.com', 'https://ops.example.com/', 'https://ops.example.com/path',
    'https://ops.example.com:8443', 'https://ops.example.com#x', 'https://user:secret@ops.example.com',
    'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://ops.example.com.', 'https://ops_example.com']) {
    assert.throws(() => createPlatformPasskeyVerifier({ publicOrigin, environment: 'int' }), /CONFIGURATION_INVALID/);
  }
});

test('Demo entrypoints cannot reach passkey verification and other source modules cannot import its SDK', () => {
  for (const surface of ['customer', 'platform']) {
    const violations = architectureConsolidationBoundaryViolations({
      [`src/demo/${surface}-composition.js`]: "import '../integrations/passkey-proxy.js';",
      'src/integrations/passkey-proxy.js': "import '../platform/identity/passkey-verifier.js';",
      'src/platform/identity/passkey-verifier.js': 'export const verifier = true;',
    });
    assert.ok(violations.some((value) => value.includes('must not reach real Platform passkey')));
  }
  const violations = architectureConsolidationBoundaryViolations({
    'src/platform/app.js': "import { verifyAuthenticationResponse } from '@simplewebauthn/server';",
  });
  assert.ok(violations.some((value) => value.includes('SDK is restricted')));
});
