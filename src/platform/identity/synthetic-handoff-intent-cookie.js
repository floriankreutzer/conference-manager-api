import { createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import { isInternalUuid,isOpaqueBrowserToken } from '../../domain/identifiers.js';
import { normalizeSyntheticHandoffScope } from '../../domain/synthetic-handoff.js';

export const PLATFORM_SYNTHETIC_INTENT_COOKIE='cm_platform_synthetic_intent';
const PATH='/api/v1/platform/auth/delegation',LIFETIME=600_000;
function invalid() { throw new TypeError('PLATFORM_SYNTHETIC_INTENT_COOKIE_INVALID'); }
function fields(flowId,state) {
  if (!isInternalUuid(flowId) || flowId!==flowId.toLowerCase() || !isOpaqueBrowserToken(state)) invalid();
}
function attributes(seconds) { return `Path=${PATH}; HttpOnly; SameSite=Strict; Secure; Max-Age=${seconds}`; }

// Transient, signed intent survives real Microsoft/passkey login without JS
// storage or a current Strict MFA cookie on the cross-site arrival request.
// This cookie grants no identity, generation, proof or Customer session.
export function createPlatformSyntheticHandoffIntentCookie({ scope,secret,clock=Date.now,
  randomToken=()=>randomBytes(32).toString('base64url') }={}) {
  scope=normalizeSyntheticHandoffScope(scope);
  if (typeof secret!=='string' || Buffer.byteLength(secret)<32 || Buffer.byteLength(secret)>512
    || /[\u0000-\u001f\u007f]/.test(secret) || typeof clock!=='function' || typeof randomToken!=='function') invalid();
  const key=Buffer.from(secret,'utf8'),namespace=JSON.stringify(scope);let destroyed=false;
  function now() { const time=clock();if (!Number.isSafeInteger(time) || time<0) invalid();return time; }
  function mac(value) {
    if (destroyed) throw new Error('PLATFORM_SYNTHETIC_INTENT_UNAVAILABLE');
    return createHmac('sha256',key).update(`synthetic-ops-intent:v1:${namespace}:${value}`,'utf8').digest('base64url');
  }
  function parse(value) {
    if (typeof value!=='string' || value.length>210) return null;
    const [flowId,state,nonce,expiry,signature,...extra]=value.split('.');
    try { fields(flowId,state); } catch { return null; }
    if (extra.length || !isOpaqueBrowserToken(nonce) || !isOpaqueBrowserToken(signature)
      || !/^[1-9]\d{0,15}$/.test(expiry ?? '') || !Number.isSafeInteger(Number(expiry))) return null;
    const time=now(),expiresAt=Number(expiry);if (time>=expiresAt || expiresAt>time+LIFETIME) return null;
    const expected=mac([flowId,state,nonce,expiry].join('.'));
    if (!timingSafeEqual(Buffer.from(expected,'ascii'),Buffer.from(signature,'ascii'))) return null;
    return Object.freeze({ flowId,state });
  }
  return Object.freeze({
    issue({ flowId,state }={}) {
      fields(flowId,state);const nonce=randomToken();if (!isOpaqueBrowserToken(nonce)) invalid();
      const expiresAt=now()+LIFETIME;if (!Number.isSafeInteger(expiresAt)) invalid();
      const value=[flowId,state,nonce,expiresAt].join('.');
      return `${PLATFORM_SYNTHETIC_INTENT_COOKIE}=${value}.${mac(value)}; ${attributes(600)}`;
    },
    read(headers) {
      const raw=headers?.cookie;if (typeof raw!=='string' || raw.length<1 || raw.length>8192) return null;
      let seen=false,result=null;
      for (const part of raw.split(';')) {
        const separator=part.indexOf('=');if (separator<1 || part.slice(0,separator).trim()!==PLATFORM_SYNTHETIC_INTENT_COOKIE) continue;
        if (seen) return null;seen=true;result=parse(part.slice(separator+1).trim());if (!result) return null;
      }
      return result;
    },
    clear() { return `${PLATFORM_SYNTHETIC_INTENT_COOKIE}=; ${attributes(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`; },
    destroy() { destroyed=true;key.fill(0); },
  });
}
