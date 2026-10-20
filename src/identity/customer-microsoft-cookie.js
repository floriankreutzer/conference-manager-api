import { isInternalUuid } from '../domain/identifiers.js';
const NAME='cm_customer_microsoft_tx',PATH='/api/v1/auth/microsoft',TOKEN=/^[A-Za-z0-9_-]{43}$/;
function attributes(maxAgeSeconds,sameSite) {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds<0 || maxAgeSeconds>600 || !['Lax','Strict'].includes(sameSite)) {
    throw new TypeError('CUSTOMER_MICROSOFT_COOKIE_INVALID');
  }
  return `Path=${PATH}; HttpOnly; SameSite=${sameSite}; Secure; Max-Age=${maxAgeSeconds}`;
}
function parse(value) {
  if (typeof value!=='string' || value.length!==80) return null;
  const [flowId,browserToken,...extra]=value.split('.');
  if (extra.length || !isInternalUuid(flowId) || flowId!==flowId.toLowerCase() || !TOKEN.test(browserToken)) return null;
  return Object.freeze({ flowId,browserToken });
}
export function readCustomerMicrosoftTransactionCookie(headers) {
  const raw=headers?.cookie;if (typeof raw!=='string' || !raw.length || raw.length>8192) return null;
  let result=null;
  for (const part of raw.split(';')) {
    const index=part.indexOf('=');if (index<1 || part.slice(0,index).trim()!==NAME) continue;
    if (result!==null) return null;result=parse(part.slice(index+1).trim());if (result===null) return null;
  }
  return result;
}
export function serializeCustomerMicrosoftTransactionCookie({ flowId,browserToken }={}, { maxAgeSeconds=600,sameSite='Lax' }={}) {
  if (!isInternalUuid(flowId) || typeof browserToken!=='string' || !TOKEN.test(browserToken) || maxAgeSeconds===0) {
    throw new TypeError('CUSTOMER_MICROSOFT_COOKIE_INVALID');
  }
  return `${NAME}=${flowId.toLowerCase()}.${browserToken}; ${attributes(maxAgeSeconds,sameSite)}`;
}
export function clearCustomerMicrosoftTransactionCookie() {
  return `${NAME}=; ${attributes(0,'Lax')}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
