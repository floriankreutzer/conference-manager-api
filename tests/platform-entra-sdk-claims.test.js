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

function fixture() {
  const claims = { id_token: {
    acrs: { essential: true, values: ['c1'] },
    signin_state: { essential: false }, login_hint: { essential: false },
    tenant_region_sub_scope: { essential: false },
  } };
  const url = new URL(`${contract.authority}/oauth2/v2.0/authorize`);
  for (const [key, value] of Object.entries({
    client_id: contract.clientId, redirect_uri: contract.redirectUri,
    scope: 'openid profile offline_access', clidata: '1',
    response_mode: 'query', response_type: 'code', max_age: '900',
    state: contract.expectedState, nonce: contract.expectedNonce,
    code_challenge: contract.expectedCodeChallenge, code_challenge_method: 'S256',
  })) url.searchParams.set(key, value);
  return { claims, url };
}

function validate(claims, url) {
  url.searchParams.set('claims', typeof claims === 'string' ? claims : JSON.stringify(claims));
  return validatePlatformEntraAuthorizationUrl(canonicalizePlatformEntraSdkUrl(url.toString()), contract);
}

test('exact SDK nonessential claim defaults never expand the platform redirect contract', () => {
  const { claims, url } = fixture();
  const result = new URL(validate(claims, url));
  assert.deepEqual(JSON.parse(result.searchParams.get('claims')), {
    id_token: { acrs: { essential: true, values: ['c1'] } },
  });
  assert.equal(result.searchParams.get('scope'), 'openid profile');
});

for (const name of ['signin_state', 'login_hint', 'tenant_region_sub_scope']) {
  for (const value of [null, false, [], {}, { essential: true }, { essential: false, value: 'unexpected' }]) {
    test(`rejects changed ${name} SDK claim shape ${JSON.stringify(value)}`, () => {
      const { claims, url } = fixture();
      claims.id_token[name] = value;
      assert.throws(() => validate(claims, url), /PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID/);
    });
  }
}

for (const [name, mutate] of [
  ['unknown identity claim', (claims) => { claims.id_token.unknown = { essential: false }; }],
  ['unknown access token request', (claims) => { claims.access_token = {}; }],
  ['altered assurance context', (claims) => { claims.id_token.acrs.values = ['c2']; }],
  ['nonessential assurance', (claims) => { claims.id_token.acrs.essential = false; }],
  ['missing assurance', (claims) => { delete claims.id_token.acrs; }],
]) {
  test(`SDK claim reduction still rejects ${name}`, () => {
    const { claims, url } = fixture();
    mutate(claims);
    assert.throws(() => validate(claims, url), /PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID/);
  });
}

for (const value of ['invalid-json', 'x'.repeat(4_097), null, [], { id_token: [] }]) {
  test(`rejects invalid bounded SDK claims ${typeof value}`, () => {
    assert.throws(() => validate(value, fixture().url), /PLATFORM_ENTRA_AUTHORIZATION_URL_INVALID/);
  });
}
