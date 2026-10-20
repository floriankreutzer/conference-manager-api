import assert from 'node:assert/strict';
import { ConfidentialClientApplication } from '@azure/msal-node';

// Actual pinned MSAL with isolated in-memory provider responses. No HTTP leaves
// this fixture; synthetic JWT bytes are not real Microsoft/device acceptance.
export function microsoftCodeSdkFixture({ clientId,authority,tenantId,userId,clock,authenticationContext='c1' }) {
  const state={ sentNonce: null,returnedNonce: null,tokenRequests: 0 };
  const origin=new URL(authority).origin;
  const metadata={ issuer: `${origin}/{tenantid}/v2.0`,authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
    token_endpoint: `${authority}/oauth2/v2.0/token`,end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
    jwks_uri: `${authority}/discovery/v2.0/keys` };
  const discovery={ tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,metadata: [{
    preferred_network: 'login.microsoftonline.com',preferred_cache: 'login.windows.net',
    aliases: ['login.microsoftonline.com','login.windows.net','sts.windows.net'],
  }] };
  const networkClient={ async sendGetRequestAsync(value) {
    const url=new URL(value);assert.equal(url.origin,origin);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return { status: 200,headers: {},body: metadata };
    assert.equal(url.pathname,'/common/discovery/instance');return { status: 200,headers: {},body: discovery };
  },async sendPostRequestAsync(value,options) {
    const url=new URL(value);assert.equal(url.origin,origin);
    assert.equal(url.pathname,new URL(authority).pathname+'/oauth2/v2.0/token');
    assert.ok([...url.searchParams.keys()].every(key=>key==='client-request-id'));state.tokenRequests++;
    const request=new URLSearchParams(options.body);assert.equal(request.get('grant_type'),'authorization_code');
    assert.ok(request.get('code_verifier'));const seconds=Math.floor(clock()/1000);
    const claims={ aud: clientId,tid: tenantId,oid: userId,iss: `${origin}/${tenantId}/v2.0`,
      nonce: state.returnedNonce ?? state.sentNonce,ver: '2.0',iat: seconds,auth_time: seconds,exp: seconds+3600,
      acrs: [authenticationContext],preferred_username: 'synthetic@example.test' };
    const idToken=[{ alg: 'RS256',typ: 'JWT' },claims].map(entry=>Buffer.from(JSON.stringify(entry)).toString('base64url'))
      .concat(Buffer.from('synthetic-signature-not-real-provider-proof').toString('base64url')).join('.');
    return { status: 200,headers: {},body: { token_type: 'Bearer',scope: 'openid profile',expires_in: 3600,
      access_token: 'synthetic-token-not-a-business-session',id_token: idToken,
      client_info: Buffer.from(JSON.stringify({ uid: userId,utid: tenantId })).toString('base64url') } };
  } };
  function application() {
    return new ConfidentialClientApplication({ auth: { clientId,authority,clientSecret: 's'.repeat(48),
      authorityMetadata: JSON.stringify(metadata),cloudDiscoveryMetadata: JSON.stringify(discovery) },
    system: { networkClient,loggerOptions: { piiLoggingEnabled: false,loggerCallback(){} } } });
  }
  return { state,application };
}
