export const PLATFORM_ENTRA_TRANSACTION_COOKIE_NAME = 'cm_platform_oidc_tx';
export const PLATFORM_ENTRA_TRANSACTION_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CALLBACK_PATH = '/api/v1/platform/auth/microsoft/callback';

function attributes(maxAgeSeconds) {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 600) {
    throw new TypeError('PLATFORM_OIDC_COOKIE_MAX_AGE_INVALID');
  }
  return [
    `Path=${CALLBACK_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function readPlatformEntraTransactionCookie(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 8_192) return null;
  let token = null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== PLATFORM_ENTRA_TRANSACTION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (token !== null || !PLATFORM_ENTRA_TRANSACTION_COOKIE_PATTERN.test(value)) return null;
    token = value;
  }
  return token;
}

export function serializePlatformEntraTransactionCookie(token, { maxAgeSeconds }) {
  if (!PLATFORM_ENTRA_TRANSACTION_COOKIE_PATTERN.test(token || '')) {
    throw new TypeError('PLATFORM_OIDC_BROWSER_BINDING_INVALID');
  }
  return `${PLATFORM_ENTRA_TRANSACTION_COOKIE_NAME}=${token}; ${attributes(maxAgeSeconds)}`;
}

export function serializeClearedPlatformEntraTransactionCookie() {
  return `${PLATFORM_ENTRA_TRANSACTION_COOKIE_NAME}=; ${attributes(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
