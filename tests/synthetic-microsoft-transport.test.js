import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntheticOperationTransport } from '../src/platform/http/synthetic-operation-transport.js';
import { serializePlatformMicrosoftOperationBrowserCookie,serializePlatformMicrosoftOperationCookie }
  from '../src/platform/identity/microsoft-operation-cookie.js';
import { createPlatformEntraOperationClient } from '../src/platform/identity/entra-client.js';
import { microsoftCodeSdkFixture } from './support/microsoft-code-sdk-fixture.js';

const id='11111111-1111-4111-8111-111111111111',origin='https://operations.example.test';
const state=Buffer.alloc(32,1).toString('base64url'),browser=Buffer.alloc(32,2).toString('base64url');
const authority=`https://login.microsoftonline.com/${id}`,callback=origin+'/api/v1/platform/auth/microsoft/operation/callback';

test('synthetic Microsoft transport preserves callback and Strict cookies and accepts only fixed provider binding',async()=>{
  const sdk=microsoftCodeSdkFixture({ clientId: id,authority,tenantId: id,userId: id });
  const client=createPlatformEntraOperationClient({ clientId: id,clientSecret: 's'.repeat(48),authority,tenantReference: id,
    publicOrigin: origin,redirectUri: callback,mfaAuthenticationContext: 'cm:ms:mfa:v1',stepUpAuthenticationContext: 'cm:ms:fresh:v1',
    application: sdk.application() });
  const authorizationUrl=await client.authorizationUrl({ state,nonce: browser,codeChallenge: browser,
    authenticationContext: 'cm:ms:fresh:v1' });
  const setCookies=[serializePlatformMicrosoftOperationBrowserCookie(`${state}.${browser}`),
    serializePlatformMicrosoftOperationCookie(`${state}.${browser}`,120)];
  const result={ status: 'microsoft_required',state,authorizationUrl,setCookies };
  const transport=createSyntheticOperationTransport({ assuranceMode: 'microsoft_mfa',platformOrigin: origin,securityEpoch: 7 });
  const runtime={ platformEntraAuthority: authority,platformEntraClientId: id };
  assert.equal(new URL(authorizationUrl).searchParams.get('prompt'),'login');
  assert.deepEqual(transport.challenge(result,id,runtime),{ cookies: setCookies,
    payload: { status: 'microsoft_required',state,authorizationUrl,requestId: id } });
  assert.equal(transport.normalContext,'cm:ms:mfa:v1');assert.equal(transport.microsoft,true);
  for (const changed of [
    { authorizationUrl: authorizationUrl.replace('max_age=300','max_age=0') },{ status: 'passkey_required' },{ setCookies: [setCookies[1],setCookies[0]] },
    { state: browser },{ authorizationUrl: authorizationUrl.replace('login.microsoftonline.com','evil.example.test') },
    { authorizationUrl: authorizationUrl.replace('prompt=login','prompt=select_account') },
    { authorizationUrl: authorizationUrl+'&prompt=login' },
    { authorizationUrl: authorizationUrl.replace(encodeURIComponent(callback),encodeURIComponent(origin+'/other')) }]) {
    assert.throws(()=>transport.challenge({ ...result,...changed },id,runtime));
  }
  assert.equal(transport.readCookie({ cookie: 'cm_platform_passkey_operation=legacy' }),null);
  assert.throws(()=>createSyntheticOperationTransport({ assuranceMode: 'browser-selected' }));
  assert.equal(createSyntheticOperationTransport().normalContext,'cm:pk:v1');
});
