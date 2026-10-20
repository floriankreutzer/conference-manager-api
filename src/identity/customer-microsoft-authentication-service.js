import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizePrincipal } from './principal.js';
import { EntraAuthenticationError } from './entra-errors.js';
import { serializeCustomerMicrosoftTransactionCookie,clearCustomerMicrosoftTransactionCookie } from './customer-microsoft-cookie.js';

const TOKEN=/^[A-Za-z0-9_-]{43}$/,HASH=/^[a-f0-9]{64}$/;
const invalid=()=>{ throw new TypeError('CUSTOMER_MICROSOFT_AUTH_INPUT_INVALID'); };
function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length!==keys.length || own.some(key=>{
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) invalid();
}
function uuid(value) { if (!isInternalUuid(value)) invalid();return value.toLowerCase(); }
function instant(value) {
  if (typeof value!=='string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString()!==value) invalid();return value;
}
function emailPrincipal(value) {
  const principal=normalizePrincipal(value);
  if (principal.providerIdentity.provider!=='email_code') {
    throw new EntraAuthenticationError('CUSTOMER_MICROSOFT_EMAIL_REAUTHENTICATION_REQUIRED');
  }
  return principal;
}
const rejected=()=>Object.freeze({ status: 'rejected',setCookie: clearCustomerMicrosoftTransactionCookie() });

// The repository owns durable one-use state, database time, abuse budgets and
// current email/member/session authority. Only this service consumes the opaque
// adapter proof; no caller-supplied claims or email address can reach admission.
export function createCustomerMicrosoftAuthenticationService({ repository,entraClient,flowBinding,idFactory=randomUUID }={}) {
  if (!repository || ['create','reserve','verified','fail'].some(method=>typeof repository[method]!=='function')
    || !entraClient || ['authorizationUrl','redeemAuthorizationCode','verifyPrimary'].some(method=>typeof entraClient[method]!=='function')
    || !flowBinding || ['issueState','protocol','issueBrowser'].some(method=>typeof flowBinding[method]!=='function')
    || typeof idFactory!=='function') throw new TypeError('CUSTOMER_MICROSOFT_AUTH_CONFIGURATION_INVALID');
  async function start(input,purpose) {
    exact(input,purpose==='login' ? ['correlationId','sourceKey'] : ['correlationId','sourceKey','principal']);
    const correlationId=uuid(input.correlationId);
    if (typeof input.sourceKey!=='string' || !HASH.test(input.sourceKey)) invalid();
    const principal=purpose==='link' ? emailPrincipal(input.principal) : null;
    const protocol=flowBinding.issueState({ purpose }),flowId=uuid(idFactory()),context={ flowId,purpose,stage: 'authorization' };
    const browser=flowBinding.issueBrowser(context);
    const created=await repository.create({ flowId,purpose,stateHash: protocol.stateHash,nonceHash: protocol.nonceHash,
      browserVerifier: browser.browserVerifier,correlationId,sourceKey: input.sourceKey,principal });
    if (created===null) return rejected();
    exact(created,['flowId','startedAt']);instant(created.startedAt);if (created.flowId!==flowId) invalid();
    let authorizationUrl;
    try {
      authorizationUrl=await entraClient.authorizationUrl({
        state: protocol.state,nonce: protocol.nonce,codeChallenge: protocol.codeChallenge,
      });
    }
    catch {
      await repository.fail({ flowId,browserToken: browser.browserToken,correlationId });
      throw new EntraAuthenticationError('CUSTOMER_MICROSOFT_PROVIDER_UNAVAILABLE');
    }
    return Object.freeze({ status: 'redirect',authorizationUrl,
      setCookie: serializeCustomerMicrosoftTransactionCookie({ flowId,browserToken: browser.browserToken }) });
  }
  return Object.freeze({
    startLogin(input) { return start(input,'login'); },
    startLink(input) { return start(input,'link'); },
    async complete(input) {
      exact(input,['flowId','browserToken','state','code','providerError','correlationId','principal']);
      const flowId=uuid(input.flowId),correlationId=uuid(input.correlationId);
      if (typeof input.browserToken!=='string' || !TOKEN.test(input.browserToken)
        || typeof input.state!=='string' || !TOKEN.test(input.state)) return rejected();
      if (input.providerError!==null && (typeof input.providerError!=='string' || !/^[a-z][a-z0-9_]{1,63}$/.test(input.providerError)
        || input.code!==undefined) || input.providerError===null
        && (typeof input.code!=='string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(input.code))) invalid();
      // Both purposes hash the same random state; purpose-dependent nonce/PKCE
      // is recovered only after the repository returns its immutable purpose.
      const stateHash=flowBinding.protocol({ state: input.state,purpose: 'login' }).stateHash;
      const reserved=await repository.reserve({
        flowId,stateHash,browserToken: input.browserToken,correlationId,principal: input.principal,
      });
      if (reserved===null) return rejected();
      exact(reserved,['flowId','purpose','nonceHash','startedAt']);
      if (reserved.flowId!==flowId || !['login','link'].includes(reserved.purpose)
        || typeof reserved.nonceHash!=='string' || !HASH.test(reserved.nonceHash)) invalid();
      instant(reserved.startedAt);
      if (input.providerError!==null) {
        await repository.fail({ flowId,browserToken: input.browserToken,correlationId });return rejected();
      }
      const protocol=flowBinding.protocol({ state: input.state,purpose: reserved.purpose });
      let identity;
      try {
        if (reserved.purpose==='link') emailPrincipal(input.principal);
        const assertion=await entraClient.redeemAuthorizationCode({ code: input.code,codeVerifier: protocol.codeVerifier,
          expectedNonce: protocol.nonce,expectedNonceHash: reserved.nonceHash,startedAt: reserved.startedAt });
        identity=await entraClient.verifyPrimary(assertion,{ expectedNonceHash: reserved.nonceHash });
        exact(identity,['provider','tenantReference','userReference','authenticatedAt']);
        if (identity.provider!=='microsoft_entra') invalid();
        uuid(identity.tenantReference);uuid(identity.userReference);instant(identity.authenticatedAt);
      } catch {
        await repository.fail({ flowId,browserToken: input.browserToken,correlationId });
        throw new EntraAuthenticationError('CUSTOMER_MICROSOFT_PRIMARY_REJECTED');
      }
      const browser=flowBinding.issueBrowser({
        flowId,purpose: reserved.purpose,stage: reserved.purpose==='login' ? 'choice' : 'confirmation',
      });
      const accepted=await repository.verified({ flowId,identity,choiceVerifier: browser.browserVerifier,
        browserToken: input.browserToken,correlationId,principal: input.principal });
      if (accepted!==true) return rejected();
      return Object.freeze({ status: reserved.purpose==='login' ? 'membership_required' : 'link_confirmation_required',
        csrfToken: browser.csrfToken,setCookie: serializeCustomerMicrosoftTransactionCookie({ flowId,browserToken: browser.browserToken },
          { maxAgeSeconds: 300,sameSite: 'Strict' }) });
    },
    clearCookie: clearCustomerMicrosoftTransactionCookie,
  });
}
