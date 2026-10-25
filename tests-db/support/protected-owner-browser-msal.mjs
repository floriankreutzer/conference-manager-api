import { microsoftCodeSdkFixture } from '../../tests/support/microsoft-code-sdk-fixture.js';

// The actual pinned SDK exchanges only isolated in-memory provider responses.
// This is not real Microsoft/device MFA and supplies no business/session issuer.
export class ConfidentialClientApplication {
  constructor(config) {
    const clientId=config?.auth?.clientId,authority=config?.auth?.authority,subject=process.env.CM_OWNER_BROWSER_SUBJECT;
    const directory=process.env.PROTECTED_PLATFORM_ENTRA_TENANT_ID;
    if (![clientId,subject,directory].every(value=>typeof value==='string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
      || authority!==`https://login.microsoftonline.com/${directory}`) throw new Error('OWNER_BROWSER_PROVIDER_FIXTURE_INVALID');
    const fixture=microsoftCodeSdkFixture({ clientId,authority,tenantId: directory,userId: subject,
      clock: ()=>Date.now(),authenticationContext: 'cm:ms:fresh:v1' });fixture.state.amr=['pwd','mfa'];
    const application=fixture.application(),authorize=application.getAuthCodeUrl.bind(application);
    application.getAuthCodeUrl=async input=>{
      const url=await authorize(input);fixture.state.sentNonce=new URL(url).searchParams.get('nonce');return url;
    };
    return application;
  }
}
