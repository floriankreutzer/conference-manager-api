import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPlatformEntraMfaClient, createPlatformEntraPrimaryClient } from '../src/platform/identity/entra-client.js';
import { validatePlatformEntraMfaAuthorizationUrl } from '../src/platform/identity/entra-authorization-url.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const DIRECTORY = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://platform.example.com';
const AUTHORITY = `https://login.microsoftonline.com/${DIRECTORY}`;
const REDIRECT = `${ORIGIN}/api/v1/platform/auth/microsoft/callback`;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const NONCE = 'N'.repeat(43);
const NORMAL = 'cm:ms:mfa:v1', FRESH = 'cm:ms:fresh:v1';
const request = { state: 'S'.repeat(43), nonce: NONCE, codeChallenge: 'C'.repeat(43), authenticationContext: NORMAL };
const redeem = { code: 'code', codeVerifier: 'V'.repeat(43), expectedNonce: NONCE,
  expectedNonceHash: createHash('sha256').update(NONCE).digest('hex'), authenticationContext: NORMAL };
const claims = () => ({ aud: CLIENT, tid: DIRECTORY, oid: SUBJECT, iss: `${AUTHORITY}/v2.0`, nonce: NONCE,
  ver: '2.0', auth_time: NOW / 1000 - 10, iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, amr: ['pwd', 'mfa'],
  roles: ['forged-owner'], groups: ['forged-group'], email: 'ignored@example.com' });
function client(token = claims(), options = {}) {
  return createPlatformEntraMfaClient({ clientId: CLIENT, clientSecret: 's'.repeat(48), tenantReference: DIRECTORY,
    authority: AUTHORITY, redirectUri: REDIRECT, publicOrigin: ORIGIN, clock: () => NOW,
    mfaAuthenticationContext: NORMAL, stepUpAuthenticationContext: FRESH,
    application: {
      async getAuthCodeUrl(value) {
        const url = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`);
        for (const [key, item] of Object.entries({ client_id: CLIENT, redirect_uri: REDIRECT, scope: 'openid profile',
          response_type: 'code', response_mode: 'query', max_age: String(value.maxAge), state: value.state,
          nonce: value.nonce, code_challenge: value.codeChallenge, code_challenge_method: 'S256', claims: value.claims })) {
          url.searchParams.set(key, item);
        }
        return url.toString();
      },
      async acquireTokenByCode(value) { assert.equal(value.nonce, NONCE); return { idTokenClaims: token }; },
    }, ...options });
}

test('Microsoft MFA requests auth_time/amr without Conditional Access, extra scopes or WebAuthn', async () => {
  const mfa = client(), url = new URL(await mfa.authorizationUrl(request));
  assert.deepEqual(JSON.parse(url.searchParams.get('claims')), {
    id_token: { auth_time: { essential: true }, amr: { essential: true } },
  });
  assert.equal(url.searchParams.get('max_age'), '300');
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(mfa.verifyPrimary, undefined);
  const verified = await mfa.verify(await mfa.redeemAuthorizationCode(redeem));
  assert.deepEqual(verified.claims, { provider: 'microsoft_entra_platform', issuer: `${AUTHORITY}/v2.0`,
    audience: CLIENT, tenantReference: DIRECTORY, subjectReference: SUBJECT,
    authenticatedAt: new Date(NOW - 10000).toISOString(), authenticationContext: NORMAL });
  assert.equal(verified.verified, true);
  const fresh = new URL(await mfa.authorizationUrl({ ...request, authenticationContext: FRESH }));
  assert.equal(fresh.searchParams.get('max_age'), '0');
});

test('an MFA request or an Authenticator-shaped method alone never grants Microsoft MFA', async () => {
  for (const amr of [undefined, null, 'mfa', [], ['pwd'], ['rsa'], ['ngcmfa'], ['MFA'], ['mfa', 'mfa'],
    ['mfa', null], ['mfa', 'x'.repeat(33)], Array(17).fill('mfa')]) {
    await assert.rejects(client({ ...claims(), amr }).redeemAuthorizationCode(redeem),
      { code: 'PLATFORM_MICROSOFT_MFA_REQUIRED' });
  }
  for (const amr of [['mfa'], ['pwd', 'rsa', 'mfa'], ['totp', 'mfa']]) {
    const mfa = client({ ...claims(), amr });
    assert.equal((await mfa.verify(await mfa.redeemAuthorizationCode(redeem))).verified, true);
  }
});

test('MFA assertions are opaque, instance-bound, one-use and expire; primary proofs cannot substitute', async () => {
  let now = NOW;
  const mfa = client(claims(), { clock: () => now });
  const proof = await mfa.redeemAuthorizationCode(redeem);
  assert.deepEqual(proof, { status: 'microsoft_mfa_verified' });
  await assert.rejects(client().verify(proof), /NOT_VERIFIED/);
  await assert.rejects(mfa.verify({ ...proof }), /NOT_VERIFIED/);
  await mfa.verify(proof);
  await assert.rejects(mfa.verify(proof), /NOT_VERIFIED/);
  const expired = await mfa.redeemAuthorizationCode(redeem);
  now += 351000;
  await assert.rejects(mfa.verify(expired), /MFA_EXPIRED/);
  await assert.rejects(mfa.verify(expired), /NOT_VERIFIED/);
  const primary = createPlatformEntraPrimaryClient({ clientId: CLIENT, clientSecret: 'p'.repeat(48),
    tenantReference: DIRECTORY, authority: AUTHORITY, redirectUri: REDIRECT, publicOrigin: ORIGIN, clock: () => NOW,
    application: { async getAuthCodeUrl() {}, async acquireTokenByCode() { return { idTokenClaims: claims() }; } } });
  const primaryProof = await primary.redeemAuthorizationCode({ ...redeem, authenticationContext: undefined });
  await assert.rejects(client().verify(primaryProof), /NOT_VERIFIED/);
});

test('Microsoft MFA preserves tenant/audience/issuer/nonce/time checks and strict redirect claims', async () => {
  for (const change of [{ aud: DIRECTORY }, { tid: CLIENT }, { iss: 'https://evil.example' }, { nonce: 'wrong' },
    { ver: '1.0' }, { auth_time: NOW / 1000 - 361 }, { iat: NOW / 1000 - 361 }, { exp: NOW / 1000 },
    { iat: NOW / 1000 + 61 }, { auth_time: NOW / 1000 + 61 }, { exp: NOW / 1000 + 86401 }]) {
    await assert.rejects(client({ ...claims(), ...change }).redeemAuthorizationCode(redeem));
  }
  await assert.rejects(client({ ...claims(), auth_time: NOW / 1000 - 61 })
    .redeemAuthorizationCode({ ...redeem, authenticationContext: FRESH }), /NOT_FRESH/);
  const url = await client().authorizationUrl(request);
  const contract = { authority: AUTHORITY, clientId: CLIENT, redirectUri: REDIRECT, authenticationMaxAgeSeconds: 300,
    expectedState: request.state, expectedNonce: NONCE, expectedCodeChallenge: request.codeChallenge };
  assert.equal(validatePlatformEntraMfaAuthorizationUrl(url, contract), url);
  for (const change of [u => u.searchParams.set('claims', '{"id_token":{"auth_time":{"essential":true}}}'),
    u => u.searchParams.set('claims', '{"id_token":{"auth_time":{"essential":true},"amr":{"essential":false}}}'),
    u => u.searchParams.set('max_age', '301'), u => u.searchParams.append('state', request.state),
    u => u.searchParams.set('redirect_uri', 'https://evil.example'), u => u.searchParams.set('scope', 'openid profile User.Read')]) {
    const changed = new URL(url); change(changed);
    assert.throws(() => validatePlatformEntraMfaAuthorizationUrl(changed.toString(), contract), /AUTHORIZATION_URL_INVALID/);
  }
});
