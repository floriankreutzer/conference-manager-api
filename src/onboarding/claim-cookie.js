export const TENANT_CLAIM_COOKIE_NAME = 'cm_tenant_claim';
export const TENANT_CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_PATH = '/api/v1/onboarding/claim';

function cookieAttributes({ secure, maxAgeSeconds }) {
  if (typeof secure !== 'boolean') throw new TypeError('COOKIE_SECURE_REQUIRED');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 900) {
    throw new TypeError('COOKIE_MAX_AGE_INVALID');
  }
  return [
    `Path=${CLAIM_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${maxAgeSeconds}`,
  ];
}

export function readTenantClaimCookie(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 8_192) return null;

  let token = null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== TENANT_CLAIM_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (token !== null || !TENANT_CLAIM_TOKEN_PATTERN.test(value)) return null;
    token = value;
  }
  return token;
}

export function serializeTenantClaimCookie(token, { secure, maxAgeSeconds }) {
  if (typeof token !== 'string' || !TENANT_CLAIM_TOKEN_PATTERN.test(token)) {
    throw new TypeError('TENANT_CLAIM_TOKEN_INVALID');
  }
  const attributes = cookieAttributes({ secure, maxAgeSeconds }).join('; ');
  return `${TENANT_CLAIM_COOKIE_NAME}=${token}; ${attributes}`;
}

export function serializeClearedTenantClaimCookie({ secure }) {
  const attributes = cookieAttributes({ secure, maxAgeSeconds: 0 }).join('; ');
  return `${TENANT_CLAIM_COOKIE_NAME}=; ${attributes}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
