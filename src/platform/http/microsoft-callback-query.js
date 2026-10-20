import { PlatformHttpError } from './errors.js';
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9._~-]{1,4096}$/;
const PROVIDER_ERROR = /^[a-z][a-z0-9_]{1,63}$/;

export function parsePlatformMicrosoftCallbackQuery(parsedUrl) {
  const keys = [...parsedUrl.searchParams.keys()];
  if (keys.some(key => !['state','code','error'].includes(key))
    || keys.some(key => parsedUrl.searchParams.getAll(key).length !== 1)) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  const state = parsedUrl.searchParams.get('state'); const code = parsedUrl.searchParams.get('code');
  const providerError = parsedUrl.searchParams.get('error');
  if (!OPAQUE.test(state || '') || ((code === null) === (providerError === null))
    || (code !== null && !CODE.test(code)) || (providerError !== null && !PROVIDER_ERROR.test(providerError))) {
    throw new PlatformHttpError(400, 'PLATFORM_VALIDATION_FAILED');
  }
  return Object.freeze({ state, code, providerError });
}
