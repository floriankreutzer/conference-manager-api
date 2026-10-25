import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { register } from 'node:module';
import test from 'node:test';
import { createPlatformClaimPolicy } from '../src/platform/identity/claim-policy.js';

test('isolated browser SDK network drives the actual Platform adapter with MFA, nonce and one-use assertion checks',async()=>{
  const directory=randomUUID(),clientId=randomUUID(),subject=randomUUID();
  const saved=[process.env.CM_OWNER_BROWSER_SUBJECT,process.env.PROTECTED_PLATFORM_ENTRA_TENANT_ID];
  process.env.CM_OWNER_BROWSER_SUBJECT=subject;process.env.PROTECTED_PLATFORM_ENTRA_TENANT_ID=directory;
  try {
    register(new URL('../tests-db/support/protected-owner-browser-msal-loader.mjs',import.meta.url),import.meta.url);
    const { createPlatformEntraOperationClient }=await import('../src/platform/identity/entra-client.js');
    const auth=createPlatformEntraOperationClient({ clientId,clientSecret: 'e'.repeat(48),tenantReference: directory,
      authority: 'https://login.microsoftonline.com/'+directory,publicOrigin: 'https://ops-int.example.com',
      redirectUri: 'https://ops-int.example.com/api/v1/platform/auth/microsoft/operation/callback',
      mfaAuthenticationContext: 'cm:ms:mfa:v1',stepUpAuthenticationContext: 'cm:ms:fresh:v1' });
    const nonce='N'.repeat(43),context='cm:ms:fresh:v1';
    const url=await auth.authorizationUrl({ state: 'S'.repeat(43),nonce,codeChallenge: 'C'.repeat(43),authenticationContext: context });
    assert.equal(new URL(url).searchParams.get('nonce'),nonce);assert.equal(new URL(url).searchParams.get('max_age'),'300');
    const assertion=await auth.redeemAuthorizationCode({ code: 'owner-browser-provider-code',codeVerifier: 'V'.repeat(43),
      expectedNonce: nonce,expectedNonceHash: createHash('sha256').update(nonce).digest('hex'),authenticationContext: context });
    const policy=createPlatformClaimPolicy({ provider: 'microsoft_entra_platform',
      issuer: `https://login.microsoftonline.com/${directory}/v2.0`,
      audience: clientId,tenantReference: directory,mfaAuthenticationContext: 'cm:ms:mfa:v1',stepUpAuthenticationContext: context });
    const identity=policy.normalize(await auth.verify(assertion));assert.equal(identity.subjectReference,subject);
    assert.equal(identity.tenantReference,directory);assert.equal(identity.assurance.level,'step_up');
    assert.equal(identity.assurance.authenticationContext,context);await assert.rejects(auth.verify(assertion));
    await assert.rejects(auth.redeemAuthorizationCode({ code: 'owner-browser-provider-code',codeVerifier: 'V'.repeat(43),
      expectedNonce: 'X'.repeat(43),expectedNonceHash: createHash('sha256').update(nonce).digest('hex'),authenticationContext: context }));
  } finally {
    for (const [index,key] of ['CM_OWNER_BROWSER_SUBJECT','PROTECTED_PLATFORM_ENTRA_TENANT_ID'].entries()) {
      if (saved[index]===undefined) delete process.env[key];else process.env[key]=saved[index];
    }
  }
});
