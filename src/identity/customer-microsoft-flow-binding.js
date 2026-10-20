import { createHash,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';

const TOKEN=/^[A-Za-z0-9_-]{43}$/,HASH=/^[a-f0-9]{64}$/;
const invalid=()=>{ throw new TypeError('CUSTOMER_MICROSOFT_FLOW_BINDING_INVALID'); };
function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const fields=Reflect.ownKeys(value);
  if (fields.length!==keys.length || fields.some(key=>{
    const property=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property,'value');
  })) invalid();
}
function context(value) {
  exact(value,['flowId','purpose','stage']);
  if (!isInternalUuid(value.flowId) || !['login','link'].includes(value.purpose)
    || !['authorization','choice','confirmation'].includes(value.stage)
    || value.stage==='choice' && value.purpose!=='login' || value.stage==='confirmation' && value.purpose!=='link') invalid();
  return `${value.purpose}:${value.stage}:${value.flowId.toLowerCase()}`;
}
function token(value) { if (typeof value!=='string' || !TOKEN.test(value)) invalid();return value; }
function equal(left,right) {
  return typeof left==='string' && HASH.test(left) && typeof right==='string' && HASH.test(right)
    && timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
}
const hash=value=>createHash('sha256').update(value,'ascii').digest('hex');

// Protocol/browser/confirmation binding only. This grants no Microsoft proof,
// membership, identity link or session; the durable repository enforces one use.
export function createCustomerMicrosoftFlowBinding({ secret,environment,randomToken=()=>randomBytes(32).toString('base64url') }={}) {
  if (typeof secret!=='string' || Buffer.byteLength(secret)<32 || Buffer.byteLength(secret)>512
    || secret.trim()!==secret || /[\u0000-\u001f\u007f]/.test(secret) || !['dev','int','prod'].includes(environment)
    || typeof randomToken!=='function') invalid();
  const key=Buffer.from(secret,'utf8');let destroyed=false;
  function hmac(domain,value,encoding='hex') {
    if (destroyed) throw new Error('CUSTOMER_MICROSOFT_FLOW_BINDING_UNAVAILABLE');
    return createHmac('sha256',key).update(`customer-microsoft-flow:v1:${environment}:${domain}:${value}`,'ascii').digest(encoding);
  }
  function browser(contextValue,browserToken) { return hmac('browser',`${context(contextValue)}:${token(browserToken)}`); }
  function csrf(contextValue,browserVerifier) {
    if (typeof browserVerifier!=='string' || !HASH.test(browserVerifier)) invalid();
    return hmac('csrf',`${context(contextValue)}:${browserVerifier}`);
  }
  function protocol(input) {
    exact(input,['state','purpose']);const state=token(input.state);
    if (!['login','link'].includes(input.purpose)) invalid();
    const nonce=hmac('nonce',`${input.purpose}:${state}`,'base64url');
    const codeVerifier=hmac('pkce',`${input.purpose}:${state}`,'base64url');
    return Object.freeze({ state,nonce,codeVerifier,codeChallenge: createHash('sha256').update(codeVerifier,'ascii').digest('base64url'),
      stateHash: hash(state),nonceHash: hash(nonce) });
  }
  return Object.freeze({
    protocol,
    issueState({ purpose }={}) { return protocol({ purpose,state: token(randomToken()) }); },
    issueBrowser(contextValue) {
      const browserToken=token(randomToken()),browserVerifier=browser(contextValue,browserToken);
      return Object.freeze({ browserToken,browserVerifier,csrfToken: csrf(contextValue,browserVerifier) });
    },
    matchesBrowser({ context: contextValue,browserToken,browserVerifier }={}) {
      if (typeof browserToken!=='string' || !TOKEN.test(browserToken)) return false;
      return equal(browserVerifier,browser(contextValue,browserToken));
    },
    csrfFor({ context: contextValue,browserVerifier }={}) { return csrf(contextValue,browserVerifier); },
    verifyCsrf({ context: contextValue,browserVerifier,csrfToken }={}) {
      if (typeof browserVerifier!=='string' || !HASH.test(browserVerifier)) return false;
      return equal(csrfToken,csrf(contextValue,browserVerifier));
    },
    destroy() { destroyed=true;key.fill(0); },
  });
}
