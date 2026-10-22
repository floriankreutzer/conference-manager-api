import { PlatformHttpError } from './errors.js';
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9._~-]{1,4096}$/;
const PROVIDER_ERROR = /^[a-z][a-z0-9_]{1,63}$/;
const RESPONSE_METADATA = Object.freeze({
  client_info: /^[A-Za-z0-9_-]{1,2048}$/,
  session_state: /^[A-Za-z0-9_-]{1,256}$/,
});

export function parsePlatformMicrosoftCallbackQuery(parsedUrl) {
  const keys = [...parsedUrl.searchParams.keys()];
  if (keys.some(key => !['state','code','error'].includes(key) && !Object.hasOwn(RESPONSE_METADATA,key))
    || keys.some(key => parsedUrl.searchParams.getAll(key).length !== 1)) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  const state = parsedUrl.searchParams.get('state'); const code = parsedUrl.searchParams.get('code');
  const providerError = parsedUrl.searchParams.get('error');
  if (!OPAQUE.test(state || '') || ((code === null) === (providerError === null))
    || (code !== null && !CODE.test(code)) || (providerError !== null && !PROVIDER_ERROR.test(providerError))
    || Object.entries(RESPONSE_METADATA).some(([key,pattern]) => parsedUrl.searchParams.has(key)
      && (code === null || !pattern.test(parsedUrl.searchParams.get(key))))) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  // SDK response metadata is bounded transport input, never identity/session authority.
  // Discard it before the independently browser-bound state and token exchange.
  return Object.freeze({ state, code, providerError });
}
