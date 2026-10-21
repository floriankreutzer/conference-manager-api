import assert from 'node:assert/strict';
import { createPrivateKey,createPublicKey } from 'node:crypto';
import test from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { platformPasskeyFixture } from './support/platform-passkey-fixture.js';
import { PROTECTED_BROWSER_ORIGINS,createProtectedBrowserRuntimeFixture }
  from '../tests-db/support/protected-browser-runtime-fixture.js';

test('qualified browser bootstrap fixes distinct actual sites and immutable refs before any database or process access',async()=>{
  assert.deepEqual(PROTECTED_BROWSER_ORIGINS,{ customer: 'https://app-int.example.test',platform: 'https://ops-int.example.com' });
  for (const value of [null,{}, { apiCommit: 'main',frontendCommit: 'b'.repeat(40) },
    { apiCommit: 'a'.repeat(40),frontendCommit: 'b'.repeat(40),issuer: ()=>{} }]) {
    await assert.rejects(createProtectedBrowserRuntimeFixture(value),/PROTECTED_BROWSER_FIXTURE_REFS_REQUIRED/);
  }
});

test('native virtual authenticator imports the same ephemeral ES256 fixture key as the pinned server public credential',()=>{
  const key=platformPasskeyFixture(),der=Buffer.from(key.exportPrivateKey(),'base64');
  const publicKey=createPublicKey(createPrivateKey({ key: der,format: 'der',type: 'pkcs8' })).export({ format: 'jwk' });
  const cose=isoCBOR.decodeFirst(Buffer.from(key.credential.publicKey,'base64url'));
  assert.equal(publicKey.crv,'P-256');assert.deepEqual(Buffer.from(publicKey.x,'base64url'),Buffer.from(cose.get(-2)));
  assert.deepEqual(Buffer.from(publicKey.y,'base64url'),Buffer.from(cose.get(-3)));
});
