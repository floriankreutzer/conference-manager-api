import { createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeSyntheticHandoffScope } from '../domain/synthetic-handoff.js';
import { normalizeOwnerCustomerAccessScope } from '../domain/owner-customer-handoff.js';
import { isCustomerEmailBrowserToken } from './customer-email-browser-token.js';

const HASH=/^[a-f0-9]{64}$/;
function equal(left,right) {
  return typeof left==='string' && typeof right==='string' && left.length===right.length
    && timingSafeEqual(Buffer.from(left,'ascii'),Buffer.from(right,'ascii'));
}

// Protocol binding only: original browser, fresh approval code and short signed
// completion. Current proof, target ownership, role, account switching and one-use
// session issuance remain authoritative repository/application responsibilities.
export function createCustomerHandoffBrowserBinding({ secret,scope,kind,
  randomToken=()=>randomBytes(32).toString('base64url') }={}) {
  if (!['synthetic','owner_real'].includes(kind)) throw new TypeError('CUSTOMER_HANDOFF_BINDING_KIND_INVALID');
  const prefix=kind==='synthetic' ? 'synthetic-handoff:v1' : 'owner-customer-handoff:v1';
  const completionSeconds=30;
  const errorPrefix=kind==='synthetic' ? 'SYNTHETIC_HANDOFF' : 'OWNER_CUSTOMER_ACCESS';
  function invalid() { throw new TypeError(`${errorPrefix}_BROWSER_BINDING_INVALID`); }
  function uuid(value) { if (!isInternalUuid(value)) invalid();return value.toLowerCase(); }
  function instant(value) {
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime()<0) invalid();return value.getTime();
  }
  function context(value) {
    if (!value || typeof value!=='object' || Array.isArray(value)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
    const keys=Reflect.ownKeys(value);
    if (keys.length!==3 || keys.some(key=>{
      const field=Object.getOwnPropertyDescriptor(value,key);
      return !['flowId','browserVerifier','codeVerifier'].includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
    }) || typeof value.browserVerifier!=='string' || !HASH.test(value.browserVerifier)
      || typeof value.codeVerifier!=='string' || !HASH.test(value.codeVerifier)) invalid();
    return [uuid(value.flowId),value.browserVerifier,value.codeVerifier];
  }
  scope=kind==='synthetic' ? normalizeSyntheticHandoffScope(scope) : normalizeOwnerCustomerAccessScope(scope);
  if (typeof secret!=='string' || Buffer.byteLength(secret)<32 || Buffer.byteLength(secret)>512
    || /[\u0000-\u001f\u007f]/.test(secret) || typeof randomToken!=='function') invalid();
  const key=Buffer.from(secret,'utf8'),namespace=JSON.stringify(scope);let destroyed=false;
  function mac(purpose,value,encoding='hex') {
    if (destroyed) throw new Error(`${errorPrefix}_BROWSER_BINDING_UNAVAILABLE`);
    return createHmac('sha256',key).update(`${prefix}:${namespace}:${purpose}:${JSON.stringify(value)}`,'utf8')
      .digest(encoding);
  }
  function fresh() { const token=randomToken();if (!isCustomerEmailBrowserToken(token)) invalid();return token; }
  function browser(flowId,browserToken) {
    if (!isCustomerEmailBrowserToken(browserToken)) invalid();return mac('original-browser',[uuid(flowId),browserToken]);
  }
  function readCompletion(value) {
    if (typeof value!=='string' || value.length>144) return null;
    const [flowId,expiry,nonce,signature,...extra]=value.split('.');
    if (extra.length || !isInternalUuid(flowId) || flowId!==flowId.toLowerCase()
      || !/^[1-9]\d{0,15}$/.test(expiry ?? '') || !Number.isSafeInteger(Number(expiry))
      || !isCustomerEmailBrowserToken(nonce) || !isCustomerEmailBrowserToken(signature)) return null;
    return { flowId,expiry,nonce,signature };
  }
  function signatureMatches(parts,parsed) {
    return equal(parsed.signature,mac('completion',[...parts,Number(parsed.expiry),parsed.nonce],'base64url'));
  }
  return Object.freeze({
    issueStart(flowId) {
      flowId=uuid(flowId);const state=fresh(),browserToken=fresh();if (state===browserToken) invalid();
      return Object.freeze({ state,browserToken,stateHash: mac('state',state),browserVerifier: browser(flowId,browserToken) });
    },
    stateVerifier(state) { if (!isCustomerEmailBrowserToken(state)) invalid();return mac('state',state); },
    matchesBrowser({ flowId,browserToken,browserVerifier }={}) {
      if (!isCustomerEmailBrowserToken(browserToken) || typeof browserVerifier!=='string' || !HASH.test(browserVerifier)) return false;
      return equal(browserVerifier,browser(flowId,browserToken));
    },
    issueCode(flowId) {
      flowId=uuid(flowId);const code=fresh();return Object.freeze({ code,codeVerifier: mac('approval-code',[flowId,code]) });
    },
    matchesCode({ flowId,code,codeVerifier }={}) {
      if (!isCustomerEmailBrowserToken(code) || typeof codeVerifier!=='string' || !HASH.test(codeVerifier)) return false;
      return equal(codeVerifier,mac('approval-code',[uuid(flowId),code]));
    },
    issueCompletion({ binding,browserToken,now,expiresAt }={}) {
      const parts=context(binding),time=instant(now),expiry=instant(expiresAt);
      if (!equal(parts[1],browser(parts[0],browserToken)) || expiry<=time
        || expiry>time+completionSeconds*1000) invalid();
      const nonce=fresh(),value=`${parts[0]}.${expiry}.${nonce}.${mac('completion',[...parts,expiry,nonce],'base64url')}`;
      return Object.freeze({ value,csrfToken: mac('completion-csrf',[...parts,value]) });
    },
    matchesCompletion({ binding,browserToken,value,now }={}) {
      const parts=context(binding),parsed=readCompletion(value),time=instant(now);
      if (!parsed || parsed.flowId!==parts[0] || !isCustomerEmailBrowserToken(browserToken)
        || !equal(parts[1],browser(parts[0],browserToken))) return false;
      const expiry=Number(parsed.expiry);
      return time<expiry && expiry<=time+completionSeconds*1000
        && signatureMatches(parts,parsed);
    },
    completionCsrf({ binding,value }={}) {
      const parts=context(binding),parsed=readCompletion(value);
      if (!parsed || parsed.flowId!==parts[0] || !signatureMatches(parts,parsed)) invalid();
      return mac('completion-csrf',[...parts,value]);
    },
    verifyCompletionCsrf({ binding,value,csrfToken }={}) {
      if (typeof csrfToken!=='string' || !HASH.test(csrfToken)) return false;
      const parts=context(binding),parsed=readCompletion(value);
      if (!parsed || parsed.flowId!==parts[0] || !signatureMatches(parts,parsed)) return false;
      return equal(csrfToken,mac('completion-csrf',[...parts,value]));
    },
    destroy() { destroyed=true;key.fill(0); },
  });
}
