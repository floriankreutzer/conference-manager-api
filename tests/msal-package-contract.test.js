import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { createEntraClient } from '../src/identity/entra-client.js';
import { createPlatformEntraClient } from '../src/platform/identity/entra-client.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fixture(platform = false) {
  const authority = `${LOGIN_ORIGIN}/${platform ? TENANT_ID : 'organizations'}`;
  const publicOrigin = platform ? 'https://platform.example.test' : 'https://customer.example.test';
  const redirectUri = `${publicOrigin}/api/v1/${platform ? 'platform/' : ''}auth/microsoft/callback`;
  const clientSecret = randomBytes(32).toString('hex');
  const calls = [];
  const metadata = {
    authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
    token_endpoint: `${authority}/oauth2/v2.0/token`,
    end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
    issuer: `${LOGIN_ORIGIN}/${TENANT_ID}/v2.0`,
    jwks_uri: `${LOGIN_ORIGIN}/common/discovery/v2.0/keys`,
  };
  const application = new ConfidentialClientApplication({
    auth: {
      clientId: CLIENT_ID, clientSecret, authority,
      authorityMetadata: JSON.stringify(metadata),
      cloudDiscoveryMetadata: JSON.stringify({
        tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
        metadata: [{
          preferred_network: 'login.microsoftonline.com',
          preferred_cache: 'login.microsoftonline.com',
          aliases: ['login.microsoftonline.com'],
        }],
      }),
    },
    system: {
      loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      networkClient: {
        async sendGetRequestAsync() { throw new Error('UNEXPECTED_NETWORK_DISCOVERY'); },
        async sendPostRequestAsync(url, options) {
          calls.push({ url, body: new URLSearchParams(options.body) });
          return { status: 400, headers: {}, body: {
            error: 'invalid_grant', error_description: 'Synthetic rejected authorization code',
          } };
        },
      },
    },
  });
  let protocolShape;
  const sdkAuthorizationUrl = application.getAuthCodeUrl.bind(application);
  application.getAuthCodeUrl = async (request) => {
    const value = await sdkAuthorizationUrl(request);
    const parameters = new URL(value).searchParams;
    protocolShape = {
      keys: [...parameters.keys()],
      scope: parameters.get('scope'), maxAge: parameters.get('max_age'),
      sku: parameters.get('x-client-SKU'), version: parameters.get('x-client-VER'),
      os: parameters.get('x-client-OS'), cpu: parameters.get('x-client-CPU'),
    };
    return value;
  };
  const config = { clientId: CLIENT_ID, clientSecret, authority, publicOrigin, redirectUri, application };
  const client = platform ? createPlatformEntraClient({
    ...config, tenantReference: TENANT_ID,
    mfaAuthenticationContext: 'c1', stepUpAuthenticationContext: 'c2',
  }) : createEntraClient(config);
  const codeVerifier = randomBytes(32).toString('base64url');
  const request = {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  };
  return { client, authority, redirectUri, calls, request, codeVerifier, protocolShape: () => protocolShape };
}

for (const [name, platform, authenticationContext] of [
  ['customer', false, undefined], ['platform MFA', true, 'c1'], ['platform step-up', true, 'c2'],
]) {
  test(`installed MSAL preserves ${name} authorization-code query, nonce and PKCE contracts`, async (context) => {
    const { client, authority, redirectUri, request, protocolShape } = fixture(platform);
    let value;
    try {
      value = await client.authorizationUrl({ ...request, authenticationContext });
    } catch (error) {
      context.diagnostic(JSON.stringify(protocolShape()));
      throw error;
    }
    const url = new URL(value);
    assert.equal(`${url.origin}${url.pathname}`, `${authority}/oauth2/v2.0/authorize`);
    for (const [key, expected] of Object.entries({
      client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', response_mode: 'query',
      state: request.state, nonce: request.nonce,
      code_challenge: request.codeChallenge, code_challenge_method: 'S256',
    })) assert.equal(url.searchParams.get(key), expected);
    if (platform) {
      assert.equal(url.searchParams.get('max_age'), authenticationContext === 'c2' ? '0' : '900');
      assert.deepEqual(JSON.parse(url.searchParams.get('claims')).id_token.acrs.values, [authenticationContext]);
    }
    assert.equal(url.searchParams.has('client_secret'), false);
  });

  test(`installed MSAL keeps ${name} code redemption fail-closed with the exact PKCE verifier`, async () => {
    const { client, authority, redirectUri, calls, request, codeVerifier } = fixture(platform);
    await assert.rejects(client.redeemAuthorizationCode({
      code: 'synthetic-rejected-code', codeVerifier,
      expectedNonceHash: createHash('sha256').update(request.nonce).digest('hex'),
      authenticationContext,
    }), { code: platform ? 'PLATFORM_ENTRA_CODE_REDEMPTION_FAILED' : 'ENTRA_CODE_REDEMPTION_FAILED' });
    assert.equal(calls.length, 1);
    const destination = new URL(calls[0].url);
    assert.equal(`${destination.origin}${destination.pathname}`, `${authority}/oauth2/v2.0/token`);
    assert.deepEqual([...destination.searchParams.keys()], ['client-request-id']);
    assert.match(destination.searchParams.get('client-request-id'), GUID_PATTERN);
    assert.equal(destination.username, '');
    assert.equal(destination.password, '');
    assert.equal(destination.hash, '');
    assert.equal(calls[0].body.get('grant_type'), 'authorization_code');
    assert.equal(calls[0].body.get('redirect_uri'), redirectUri);
    assert.equal(calls[0].body.get('code_verifier'), codeVerifier);
  });
}
