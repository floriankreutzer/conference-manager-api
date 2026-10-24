import { isOpaqueBrowserToken } from '../../domain/identifiers.js';

export const PLATFORM_MICROSOFT_OPERATION_CALLBACK='/api/v1/platform/auth/microsoft/operation/callback';
const BROWSER='cm_platform_ms_operation_tx',OPERATION='cm_platform_ms_operation';
const MAX_AGE_SECONDS=120;
function valid(value) {
  if (typeof value!=='string' || value.length!==87) return false;
  const parts=value.split('.');return parts.length===2 && parts.every(isOpaqueBrowserToken);
}
function read(headers,name) {
  const raw=headers?.cookie;if (typeof raw!=='string' || raw.length>8192) return null;
  const values=raw.split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${name}=`));
  if (values.length!==1) return null;
  const value=values[0].slice(name.length+1);return valid(value) ? value : null;
}
function serialize(name,path,sameSite,value,seconds) {
  if (!valid(value) || !Number.isSafeInteger(seconds) || seconds<1 || seconds>MAX_AGE_SECONDS) {
    throw new TypeError('PLATFORM_MICROSOFT_OPERATION_COOKIE_INVALID');
  }
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${seconds}`;
}
function clear(name,path,sameSite) {
  return `${name}=; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0`;
}

// Lax is confined to the fixed provider callback. The separate Strict cookie
// reaches only Platform requests; neither cookie is identity or operation proof.
export function readPlatformMicrosoftOperationBrowserCookie(headers) { return read(headers,BROWSER); }
export function readPlatformMicrosoftOperationCookie(headers) { return read(headers,OPERATION); }
export function serializePlatformMicrosoftOperationBrowserCookie(value,seconds=MAX_AGE_SECONDS) {
  return serialize(BROWSER,PLATFORM_MICROSOFT_OPERATION_CALLBACK,'Lax',value,seconds);
}
export function serializePlatformMicrosoftOperationCookie(value,seconds) {
  return serialize(OPERATION,'/api/v1/platform','Strict',value,seconds);
}
export function clearPlatformMicrosoftOperationBrowserCookie() {
  return clear(BROWSER,PLATFORM_MICROSOFT_OPERATION_CALLBACK,'Lax');
}
export function clearPlatformMicrosoftOperationCookie() { return clear(OPERATION,'/api/v1/platform','Strict'); }
