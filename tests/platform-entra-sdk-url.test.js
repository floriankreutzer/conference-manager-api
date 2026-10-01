import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizePlatformEntraSdkUrl } from '../src/platform/identity/entra-sdk-authorization-url.js';
import { validatePlatformEntraAuthorizationUrl } from '../src/platform/identity/entra-authorization-url.js';

const contract = {
  authority: 'https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222',
  clientId: '11111111-1111-4111-8111-111111111111',
  redirectUri: 'https://platform.example.test/api/v1/platform/auth/microsoft/callback',
  authenticationContext: 'c1', authenticationMaxAgeSeconds: 900,
  expectedState: 'S'.repeat(43), expectedNonce: 'N'.repeat(43), expectedCodeChallenge: 'C'.repeat(43),
};

function sdkUrl() {
  const url = new URL(`${contract.authority}/oauth2/v2.0/authorize`);
  for (const [key, value] of Object.entries({
    client_id: contract.clientId, redirect_uri: contract.redirectUri,
    scope: 'openid profile offline_access', clidata: 'synthetic-sdk-telemetry',
    response_mode: 'query', response_type: 'code', max_age: '900',
    state: contract.expectedState, nonce: contract.expectedNonce,
    code_challenge: contract.expectedCodeChallenge, code_challenge_method: 'S256',
    claims: JSON.stringify({ id_token: { acrs: { essential: true, values: ['c1'] } } }),
  })) url.searchParams.set(key, value);
  return url;
}

function validate(value) {
  return validatePlatformEntraAuthorizationUrl(canonicalizePlatformEntraSdkUrl(value), contract);
}

test('SDK normalization removes offline consent and telemetry but preserves the exact secure redirect', () => {
  const source = sdkUrl();
  const result = new URL(validate(source.toString()));
  assert.equal(result.searchParams.get('scope'), 'openid profile');
  assert.equal(result.searchParams.has('clidata'), false);
  for (const [key, value] of source.searchParams) {
    if (key !== 'scope' && key !== 'clidata') assert.equal(result.searchParams.get(key), value);
  }
  assert.equal(result.origin, source.origin);
  assert.equal(result.pathname, source.pathname);
});

test('the canonical HTTP validator still rejects unadapted SDK defaults', () => {
  assert.throws(() => validatePlatformEntraAuthorizationUrl(sdkUrl().toString(), contract));
});

for (const [name, mutate] of [
  ['extra API scope', (url) => url.searchParams.set('scope', 'openid profile offline_access User.Read')],
  ['duplicate scope value', (url) => url.searchParams.set('scope', 'openid profile offline_access offline_access')],
  ['missing required scope', (url) => url.searchParams.set('scope', 'openid offline_access')],
  ['duplicate scope parameter', (url) => url.searchParams.append('scope', 'openid profile')],
  ['duplicate metadata parameter', (url) => url.searchParams.append('clidata', 'other')],
  ['oversized metadata', (url) => url.searchParams.set('clidata', 'x'.repeat(2_049))],
  ['missing freshness', (url) => url.searchParams.delete('max_age')],
  ['wrong freshness', (url) => url.searchParams.set('max_age', '1800')],
  ['duplicate freshness', (url) => url.searchParams.append('max_age', '900')],
  ['wrong nonce', (url) => url.searchParams.set('nonce', 'X'.repeat(43))],
  ['wrong state', (url) => url.searchParams.set('state', 'X'.repeat(43))],
  ['wrong PKCE', (url) => url.searchParams.set('code_challenge', 'X'.repeat(43))],
  ['wrong context', (url) => url.searchParams.set('claims', JSON.stringify({ id_token: { acrs: { essential: true, values: ['c2'] } } }))],
  ['foreign callback', (url) => url.searchParams.set('redirect_uri', 'https://other.example.test/callback')],
  ['foreign authority', (url) => { url.hostname = 'other.example.test'; }],
  ['URL credentials', (url) => { url.username = 'unexpected'; }],
  ['URL fragment', (url) => { url.hash = 'unexpected'; }],
  ['unknown parameter', (url) => url.searchParams.set('unknown', 'value')],
]) {
  test(`SDK adaptation does not hide ${name}`, () => {
    const url = sdkUrl();
    mutate(url);
    assert.throws(() => validate(url.toString()), /PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID/);
  });
}

for (const value of [null, {}, 'invalid', 'x'.repeat(8_193)]) {
  test(`SDK adaptation rejects invalid bounded input ${typeof value}`, () => {
    assert.throws(() => canonicalizePlatformEntraSdkUrl(value), /PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID/);
  });
}
