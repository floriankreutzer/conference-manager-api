import { isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { syntheticOperationAssurance } from '../../domain/synthetic-operation-assurance.js';
import { readPlatformPasskeyTransactionCookie,serializePlatformPasskeyTransactionCookie,clearPlatformPasskeyTransactionCookie }
  from '../identity/passkey-auth-cookie.js';
import { readPlatformPasskeyOperationCookie,serializePlatformPasskeyOperationCookie,clearPlatformPasskeyOperationCookie }
  from '../identity/passkey-operation-cookie.js';
import { PLATFORM_MICROSOFT_OPERATION_CALLBACK,readPlatformMicrosoftOperationBrowserCookie,
  readPlatformMicrosoftOperationCookie,serializePlatformMicrosoftOperationBrowserCookie,serializePlatformMicrosoftOperationCookie,
  clearPlatformMicrosoftOperationBrowserCookie,clearPlatformMicrosoftOperationCookie } from '../identity/microsoft-operation-cookie.js';
import { requirePlatformProviderAuthorizationUrl } from './response.js';
import { requireCommittedPlatformSyntheticOperation } from './passkey-operation-result.js';
import { PlatformHttpError } from './errors.js';

function invalid() { throw new PlatformHttpError(500,'PLATFORM_SYNTHETIC_OPERATION_RESULT_INVALID'); }

// Fixed root-owned transport profile. This validates committed projections and
// pending browser cookies only; it cannot mint proof contexts or select identity.
export function createSyntheticOperationTransport({ assuranceMode='application_passkey',platformOrigin,securityEpoch }={}) {
  const assurance=syntheticOperationAssurance(assuranceMode),microsoft=assurance.mode==='microsoft_mfa';
  return Object.freeze({
    normalContext: assurance.normalContext,microsoft,
    readCookie: microsoft ? readPlatformMicrosoftOperationCookie : readPlatformPasskeyOperationCookie,
    clearCookies: ()=>microsoft ? [clearPlatformMicrosoftOperationBrowserCookie(),clearPlatformMicrosoftOperationCookie()]
      : [clearPlatformPasskeyTransactionCookie(),clearPlatformPasskeyOperationCookie()],
    committed: (value,principal)=>requireCommittedPlatformSyntheticOperation(value,{ principal,securityEpoch,assuranceMode }),
    challenge(result,requestId,runtime={}) {
      if (!isOpaqueBrowserToken(result?.state)) invalid();
      if (microsoft) {
        if (result.status!=='microsoft_required' || !Array.isArray(result.setCookies) || result.setCookies.length!==2) invalid();
        const cookie=readPlatformMicrosoftOperationBrowserCookie({ cookie: String(result.setCookies[0]).split(';')[0] });
        if (!cookie || cookie.split('.')[0]!==result.state
          || result.setCookies[0]!==serializePlatformMicrosoftOperationBrowserCookie(cookie,120)
          || result.setCookies[1]!==serializePlatformMicrosoftOperationCookie(cookie,120)) invalid();
        const url=new URL(requirePlatformProviderAuthorizationUrl(result.authorizationUrl,runtime.platformEntraAuthority,{
          clientId: runtime.platformEntraClientId,redirectUri: platformOrigin+PLATFORM_MICROSOFT_OPERATION_CALLBACK,
          authenticationContext: 'cm:ms:fresh:v1',authenticationMaxAgeSeconds: 300,
          expectedPrompt: 'login',
        }));
        if (url.searchParams.get('state')!==result.state
          || url.searchParams.get('redirect_uri')!==platformOrigin+PLATFORM_MICROSOFT_OPERATION_CALLBACK) invalid();
        return { cookies: [...result.setCookies],payload: { status: result.status,state: result.state,
          authorizationUrl: url.href,requestId } };
      }
      if (result.status!=='passkey_required' || !result.options || typeof result.options!=='object' || Array.isArray(result.options)
        || typeof result.setCookie!=='string') invalid();
      const cookie=readPlatformPasskeyTransactionCookie({ cookie: result.setCookie.split(';')[0] });
      if (!cookie || cookie.split('.')[0]!==result.state
        || result.setCookie!==serializePlatformPasskeyTransactionCookie(cookie,120)) invalid();
      return { cookies: serializePlatformPasskeyOperationCookie(cookie),
        payload: { status: result.status,state: result.state,options: result.options,requestId } };
    },
  });
}
