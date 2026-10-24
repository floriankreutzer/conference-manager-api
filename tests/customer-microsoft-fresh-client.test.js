import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { createFreshCustomerEntraClient } from '../src/identity/entra-client.js';

const clientId='71000000-0000-4000-8000-000000000001',tenant='71000000-0000-4000-8000-000000000002';
const subject='71000000-0000-4000-8000-000000000003',authority='https://login.microsoftonline.com/organizations';
const publicOrigin='https://127.0.0.1',secret='synthetic-customer-client-secret-test-only-00001';
const now=Date.parse('2026-10-20T12:00:00.000Z'),seconds=now/1000;
const start={ state: 'S'.repeat(43),nonce: 'N'.repeat(43),codeChallenge: 'K'.repeat(43) };
const nonceHash=createHash('sha256').update(start.nonce).digest('hex');
const redemption={ code: 'synthetic-authorization-code',codeVerifier: 'V'.repeat(43),
  expectedNonce: start.nonce,expectedNonceHash: nonceHash,
  startedAt: new Date(now-1000).toISOString() };
const claims=(extra={})=>({ aud: clientId,tid: tenant,oid: subject,iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
  nonce: start.nonce,iat: seconds,auth_time: seconds,nbf: seconds-10,exp: seconds+3600,ver: '2.0',
  email: 'Never-link-by-this@example.test',preferred_username: 'Never-link-by-this@example.test',roles: ['GlobalAdmin'],...extra });
function fixture(extra={}) {
  let clock=now;const state={ starts: [],redemptions: [],configurations: [] };
  const client=createFreshCustomerEntraClient({ clientId,clientSecret: secret,authority,publicOrigin,clock: ()=>clock,
    applicationFactory(configuration){ state.configurations.push(configuration);return {
      async getAuthCodeUrl(value){ state.starts.push(value);
        const url=new URL(`${authority}/oauth2/v2.0/authorize`);
        const query={ client_id: clientId,response_type: 'code',redirect_uri: `${publicOrigin}/api/v1/auth/microsoft/callback`,
          response_mode: value.responseMode,scope: `${value.scopes.join(' ')} offline_access`,state: value.state,nonce: value.nonce,
          code_challenge: value.codeChallenge,code_challenge_method: value.codeChallengeMethod,prompt: value.prompt,
          max_age: value.extraQueryParameters.max_age,claims: value.claims,clidata: 'synthetic SDK telemetry' };
        for (const [key,entry] of Object.entries(query)) url.searchParams.set(key,entry);
        extra.mutateUrl?.(url);return url.toString();
      },
      async acquireTokenByCode(value){ assert.equal(value.nonce,start.nonce);
        state.redemptions.push(value);return { idTokenClaims: claims(extra.claims) }; },
    }; },...extra.configuration });
  return { client,state,setClock: value=>{ clock=value; } };
}
test('fresh organizational proof binds exact OAuth fields, removes offline consent, and ignores email/role claims',async()=>{
  const { client,state }=fixture();const url=new URL(await client.authorizationUrl(start));
  assert.equal(url.searchParams.get('prompt'),'login');assert.equal(url.searchParams.get('max_age'),'0');
  assert.equal(url.searchParams.get('scope'),'openid profile');assert.equal(url.searchParams.has('clidata'),false);
  assert.deepEqual(JSON.parse(url.searchParams.get('claims')),{ id_token: { auth_time: { essential: true } } });
  const assertion=await client.redeemAuthorizationCode(redemption);assert.equal(JSON.stringify(assertion),'{}');
  const identity=await client.verifyPrimary(assertion,{ expectedNonceHash: nonceHash });
  assert.deepEqual(identity,{ provider: 'microsoft_entra',tenantReference: tenant,userReference: subject,
    authenticatedAt: new Date(now).toISOString() });
  assert.doesNotMatch(JSON.stringify(identity),/Never-link|GlobalAdmin|email|roles|displayName/);
  assert.equal(state.configurations.length,2);assert.equal(state.configurations[0].system.loggerOptions.piiLoggingEnabled,false);
  await assert.rejects(client.verifyPrimary(assertion,{ expectedNonceHash: nonceHash }),/NOT_VERIFIED/);
});
test('opaque proofs cannot be cloned, moved between clients/nonce contexts or used after freshness expires',async()=>{
  const a=fixture(),b=fixture();const assertion=await a.client.redeemAuthorizationCode(redemption);
  await assert.rejects(b.client.verifyPrimary(assertion,{ expectedNonceHash: nonceHash }),/NOT_VERIFIED/);
  await assert.rejects(a.client.verifyPrimary(structuredClone(assertion),{ expectedNonceHash: nonceHash }),/NOT_VERIFIED/);
  await assert.rejects(a.client.verifyPrimary(assertion,{ expectedNonceHash: 'a'.repeat(64) }),/NOT_VERIFIED/);
  await assert.rejects(a.client.verifyPrimary(assertion,{ expectedNonceHash: nonceHash }),/NOT_VERIFIED/);
  const expired=await a.client.redeemAuthorizationCode(redemption);a.setClock(now+300001);
  await assert.rejects(a.client.verifyPrimary(expired,{ expectedNonceHash: nonceHash }),/EXPIRED/);
});

test('selected group observation remains inside the one-use identity proof and is bounded by token expiry',async()=>{
  const f=fixture({ claims: { groups: [subject],exp: seconds+600 },configuration: { includeGroupMembership: true } });
  const assertion=await f.client.redeemAuthorizationCode(redemption);
  assert.equal(JSON.stringify(assertion),'{}');
  const identity=await f.client.verifyPrimary(assertion,{ expectedNonceHash: nonceHash });
  assert.deepEqual(identity.groupMembership,{ status: 'complete',groupIds: [subject] });
  assert.equal(identity.groupValidUntil,new Date(now+600000).toISOString());
  assert.equal(identity.tenantReference,tenant);assert.equal(identity.userReference,subject);
  await assert.rejects(f.client.verifyPrimary(assertion,{ expectedNonceHash: nonceHash }),/NOT_VERIFIED/);
});

test('group observations never treat absent claims or overage as complete membership',async()=>{
  for (const [extra,status] of [[{},'unavailable'],[{ hasgroups: true },'overage'],
    [{ _claim_names: { groups: 'src1' },_claim_sources: { src1: { endpoint: 'http://127.0.0.1/private' } } },'overage']]) {
    const f=fixture({ claims: extra,configuration: { includeGroupMembership: true } });
    const proof=await f.client.redeemAuthorizationCode(redemption);
    const identity=await f.client.verifyPrimary(proof,{ expectedNonceHash: nonceHash });
    assert.deepEqual(identity.groupMembership,{ status,groupIds: [] });
  }
});
test('stale/missing freshness and wrong issuer/audience/nonce/consumer identity fail before producing a proof',async()=>{
  for (const change of [{ auth_time: undefined },{ auth_time: seconds-361 },{ auth_time: seconds-62 },
    { auth_time: seconds+61 },{ iat: undefined },{ iat: seconds+61 },{ exp: seconds },{ nbf: seconds+61 },
    { aud: subject },{ nonce: 'wrong' },{ iss: `${authority}/v2.0` },{ ver: '1.0' },
    { tid: '9188040d-6c67-4c5b-b112-36a304b66dad',iss: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' }]) {
    const f=fixture({ claims: change });await assert.rejects(f.client.redeemAuthorizationCode(redemption),/ENTRA_/);
  }
});
test('SDK URL adaptation never hides changed authority, callback, scope, claims or browser proof',async()=>{
  for (const mutateUrl of [url=>url.searchParams.set('nonce','X'.repeat(43)),url=>url.searchParams.set('prompt','none'),
    url=>url.searchParams.append('scope','openid profile'),url=>url.searchParams.set('scope','openid profile User.Read'),
    url=>url.searchParams.set('redirect_uri','https://other.example.test/callback'),url=>{ url.hostname='other.example.test'; },
    url=>url.searchParams.set('claims',JSON.stringify({ id_token: { auth_time: { essential: false } } })),
    url=>url.searchParams.set('unknown','private'),url=>{ url.username='user'; },url=>{ url.hash='private'; }]) {
    const f=fixture({ mutateUrl });await assert.rejects(f.client.authorizationUrl(start),/URL_INVALID/);
  }
});
test('invalid inputs and protected configuration fail before any provider calls',async()=>{
  const f=fixture();
  await assert.rejects(f.client.authorizationUrl({ ...start,tenantId: tenant }),/INPUT_INVALID/);
  await assert.rejects(f.client.redeemAuthorizationCode({ ...redemption,startedAt: 'invalid' }),/INPUT_INVALID/);
  await assert.rejects(f.client.redeemAuthorizationCode({ ...redemption,email: 'Other@example.test' }),/INPUT_INVALID/);
  await assert.rejects(f.client.redeemAuthorizationCode({ ...redemption,expectedNonce: 'W'.repeat(43) }),/INPUT_INVALID/);
  assert.equal(f.state.starts.length,0);assert.equal(f.state.redemptions.length,0);
  for (const configuration of [{ authority: 'https://other.example.test/organizations' },
    { authority: authority.replace('organizations','common') },
    { publicOrigin: 'http://127.0.0.1' },{ clientSecret: 'short' },{ timeoutMs: 15001 }]) assert.throws(()=>fixture({ configuration }));
});
test('pinned real MSAL uses bounded fixed-origin transport and requests no offline grant during code redemption',async()=>{
  const requests=[];
  const tokenClaims=claims();
  const jwt=[{ alg: 'RS256',typ: 'JWT' },tokenClaims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url'))
    .concat(Buffer.from('synthetic-test-signature-not-a-real-Microsoft-proof').toString('base64url')).join('.');
  const fetchImpl=async(value,options)=>{
    const url=new URL(value);assert.equal(url.origin,'https://login.microsoftonline.com');
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    requests.push({ path: url.pathname,method: options.method });
    let payload;
    if (options.method==='GET' && url.pathname.endsWith('/.well-known/openid-configuration')) {
      payload={ issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
        authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,token_endpoint: `${authority}/oauth2/v2.0/token`,
        end_session_endpoint: `${authority}/oauth2/v2.0/logout`,jwks_uri: `${authority}/discovery/v2.0/keys` };
    } else if (options.method==='GET' && url.pathname==='/common/discovery/instance') {
      payload={ tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,metadata: [{
        preferred_network: 'login.microsoftonline.com',preferred_cache: 'login.windows.net',
        aliases: ['login.microsoftonline.com','login.windows.net','sts.windows.net'],
      }] };
    } else if (options.method==='POST' && url.pathname==='/organizations/oauth2/v2.0/token') {
      const form=new URLSearchParams(options.body);assert.equal(form.get('scope'),'openid profile');
      assert.equal(form.get('code'),redemption.code);assert.equal(form.get('code_verifier'),redemption.codeVerifier);
      payload={ token_type: 'Bearer',scope: 'openid profile',expires_in: 3600,id_token: jwt,
        access_token: 'synthetic-test-token-never-a-business-session',
        client_info: Buffer.from(JSON.stringify({ uid: subject,utid: tenant })).toString('base64url') };
    } else throw new Error('UNEXPECTED_FIXED_ORIGIN_SDK_REQUEST');
    return new Response(JSON.stringify(payload),{ status: 200,headers: { 'content-type': 'application/json' } });
  };
  let sdkUrl,sdkErrorCode;
  const client=createFreshCustomerEntraClient({ clientId,clientSecret: secret,authority,publicOrigin,clock: ()=>now,fetchImpl,
    applicationFactory(configuration) {
      const app=new ConfidentialClientApplication(configuration);
      return { async getAuthCodeUrl(input){ sdkUrl=await app.getAuthCodeUrl(input);return sdkUrl; },
        async acquireTokenByCode(input){
          try { return await app.acquireTokenByCode(input); }
          catch (error) { sdkErrorCode=error.errorCode ?? error.code ?? error.name;throw error; }
        } };
    } });
  let normalized;
  try { normalized=await client.authorizationUrl(start); }
  catch (error) { assert.fail(`${error.code}; SDK parameter names: ${[...new URL(sdkUrl).searchParams.keys()].join(',')}`); }
  const url=new URL(normalized);assert.equal(url.searchParams.get('scope'),'openid profile');
  let assertion;
  try { assertion=await client.redeemAuthorizationCode(redemption); }
  catch (error) { assert.fail(`${error.code}; SDK error code: ${sdkErrorCode}; requests: ${JSON.stringify(requests)}`); }
  assert.equal((await client.verifyPrimary(assertion,{ expectedNonceHash: nonceHash })).userReference,subject);
  assert.ok(requests.some(request=>request.method==='POST'));assert.ok(requests.every(request=>!request.path.includes('/v1.0/')));
});
