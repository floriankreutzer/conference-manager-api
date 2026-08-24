export const ENTRA_TRANSACTION_COOKIE_NAME = 'cm_oidc_tx';
export const ENTRA_TRANSACTION_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CALLBACK_PATH = '/api/v1/auth/microsoft/callback';

function cookieAttributes({ secure, maxAgeSeconds }) {
  if (typeof secure !== 'boolean') throw new TypeError('COOKIE_SECURE_REQUIRED');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 900) {
    throw new TypeError('COOKIE_MAX_AGE_INVALID');
  }
  return [
    `Path=${CALLBACK_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${maxAgeSeconds}`,
  ];
}

export function readEntraTransactionCookie(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 8_192) return null;

  let token = null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== ENTRA_TRANSACTION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (token !== null || !ENTRA_TRANSACTION_COOKIE_PATTERN.test(value)) return null;
    token = value;
  }
  return token;
}

export function serializeEntraTransactionCookie(token, { secure, maxAgeSeconds }) {
  if (typeof token !== 'string' || !ENTRA_TRANSACTION_COOKIE_PATTERN.test(token)) {
    throw new TypeError('OIDC_BROWSER_BINDING_INVALID');
  }
  const attributes = cookieAttributes({ secure, maxAgeSeconds }).join('; ');
  return `${ENTRA_TRANSACTION_COOKIE_NAME}=${token}; ${attributes}`;
}

export function serializeClearedEntraTransactionCookie({ secure }) {
  const attributes = cookieAttributes({ secure, maxAgeSeconds: 0 }).join('; ');
  return `${ENTRA_TRANSACTION_COOKIE_NAME}=; ${attributes}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
