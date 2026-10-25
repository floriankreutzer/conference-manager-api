import { isInternalUuid } from '../domain/identifiers.js';
import { isCustomerEmailBrowserToken } from './customer-email-browser-token.js';

// Infrastructure vocabulary is selected only by the two fixed owning wrappers.
// HTTP/browser input cannot select a cookie name, Path or protocol namespace.
export function createCustomerHandoffCookieCodec(kind) {
  if (!['synthetic','owner_real'].includes(kind)) throw new TypeError('CUSTOMER_HANDOFF_COOKIE_KIND_INVALID');
  const legacy=kind==='synthetic',path=legacy ? '/api/v1/auth/delegation' : '/api/v1/auth/owner';
  const browserName=legacy ? 'cm_synthetic_browser' : 'cm_owner_browser';
  const completionName=legacy ? 'cm_synthetic_completion' : 'cm_owner_completion';
  function invalid() { throw new TypeError(legacy ? 'SYNTHETIC_HANDOFF_COOKIE_INVALID' : 'OWNER_HANDOFF_COOKIE_INVALID'); }
function attributes(kind,seconds) {
  const maximum=kind==='browser' ? 600 : 30;
  if (!Number.isSafeInteger(seconds) || seconds<0 || seconds>maximum) invalid();
  return `Path=${path}; HttpOnly; SameSite=${kind==='browser' ? 'Lax' : 'Strict'}; Secure; Max-Age=${seconds}`;
}
function original(value) {
  if (typeof value!=='string' || value.length!==80) return null;
  const [flowId,browserToken,...extra]=value.split('.');
  if (extra.length || !isInternalUuid(flowId) || flowId!==flowId.toLowerCase() || !isCustomerEmailBrowserToken(browserToken)) return null;
  return Object.freeze({ flowId,browserToken });
}
function completion(value) {
  if (typeof value!=='string' || value.length>144) return null;
  const [flowId,expiry,nonce,signature,...extra]=value.split('.');
  if (extra.length || !isInternalUuid(flowId) || flowId!==flowId.toLowerCase()
    || !/^[1-9]\d{0,15}$/.test(expiry ?? '') || !Number.isSafeInteger(Number(expiry))
    || !isCustomerEmailBrowserToken(nonce) || !isCustomerEmailBrowserToken(signature)) return null;
  return value; // Only the owned cryptographic binding can authenticate it.
}
function read(headers,name,parse) {
  const raw=headers?.cookie;if (typeof raw!=='string' || raw.length<1 || raw.length>8192) return null;
  let result=null,seen=false;
  for (const part of raw.split(';')) {
    const separator=part.indexOf('=');if (separator<1 || part.slice(0,separator).trim()!==name) continue;
    if (seen) return null;seen=true;result=parse(part.slice(separator+1).trim());
    if (result===null) return null;
  }
  return result;
}
function readBrowser(headers) { return read(headers,browserName,original); }
function readCompletion(headers) { return read(headers,completionName,completion); }
function serializeBrowser({ flowId,browserToken }={},seconds=600) {
  if (!isInternalUuid(flowId) || !isCustomerEmailBrowserToken(browserToken)) invalid();
  const value=`${flowId}.${browserToken}`;if (!original(value) || seconds===0) invalid();
  return `${browserName}=${value}; ${attributes('browser',seconds)}`;
}
function serializeCompletion(value,seconds=30) {
  if (!completion(value) || seconds===0) invalid();
  return `${completionName}=${value}; ${attributes('completion',seconds)}`;
}
function clear() {
  return Object.freeze([['browser',browserName],['completion',completionName]]
    .map(([kind,name])=>`${name}=; ${attributes(kind,0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`));
}

  return Object.freeze({ path,browserName,completionName,readBrowser,readCompletion,serializeBrowser,serializeCompletion,clear });
}
