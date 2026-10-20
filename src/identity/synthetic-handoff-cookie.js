import { isInternalUuid } from '../domain/identifiers.js';
import { isCustomerEmailBrowserToken } from './customer-email-browser-token.js';

export const SYNTHETIC_HANDOFF_COOKIE_PATH='/api/v1/auth/delegation';
export const SYNTHETIC_HANDOFF_BROWSER_COOKIE='cm_synthetic_browser';
export const SYNTHETIC_HANDOFF_COMPLETION_COOKIE='cm_synthetic_completion';
function invalid() { throw new TypeError('SYNTHETIC_HANDOFF_COOKIE_INVALID'); }
function attributes(kind,seconds) {
  const maximum=kind==='browser' ? 600 : 30;
  if (!Number.isSafeInteger(seconds) || seconds<0 || seconds>maximum) invalid();
  return `Path=${SYNTHETIC_HANDOFF_COOKIE_PATH}; HttpOnly; SameSite=${kind==='browser' ? 'Lax' : 'Strict'}; Secure; Max-Age=${seconds}`;
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
export function readSyntheticHandoffBrowserCookie(headers) { return read(headers,SYNTHETIC_HANDOFF_BROWSER_COOKIE,original); }
export function readSyntheticHandoffCompletionCookie(headers) { return read(headers,SYNTHETIC_HANDOFF_COMPLETION_COOKIE,completion); }
export function serializeSyntheticHandoffBrowserCookie({ flowId,browserToken }={},seconds=600) {
  if (!isInternalUuid(flowId) || !isCustomerEmailBrowserToken(browserToken)) invalid();
  const value=`${flowId}.${browserToken}`;if (!original(value) || seconds===0) invalid();
  return `${SYNTHETIC_HANDOFF_BROWSER_COOKIE}=${value}; ${attributes('browser',seconds)}`;
}
export function serializeSyntheticHandoffCompletionCookie(value,seconds=30) {
  if (!completion(value) || seconds===0) invalid();
  return `${SYNTHETIC_HANDOFF_COMPLETION_COOKIE}=${value}; ${attributes('completion',seconds)}`;
}
export function clearSyntheticHandoffCookies() {
  return Object.freeze([['browser',SYNTHETIC_HANDOFF_BROWSER_COOKIE],['completion',SYNTHETIC_HANDOFF_COMPLETION_COOKIE]]
    .map(([kind,name])=>`${name}=; ${attributes(kind,0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`));
}
