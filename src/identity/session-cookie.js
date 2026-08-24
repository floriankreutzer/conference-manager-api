export const SESSION_COOKIE_NAME = 'cm_session';
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function cookieAttributes({ secure, maxAgeSeconds }) {
  if (typeof secure !== 'boolean') throw new TypeError('COOKIE_SECURE_REQUIRED');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 86_400) {
    throw new TypeError('COOKIE_MAX_AGE_INVALID');
  }
  return [
    `Path=/api`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${maxAgeSeconds}`,
  ];
}

export function readSessionToken(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 8_192) return null;

  let token = null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (token !== null || !SESSION_TOKEN_PATTERN.test(value)) return null;
    token = value;
  }
  return token;
}

export function serializeSessionCookie(token, { secure, maxAgeSeconds }) {
  if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) {
    throw new TypeError('SESSION_TOKEN_INVALID');
  }
  return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes({ secure, maxAgeSeconds }).join('; ')}`;
}

export function serializeClearedSessionCookie({ secure }) {
  return `${SESSION_COOKIE_NAME}=; ${cookieAttributes({ secure, maxAgeSeconds: 0 }).join('; ')}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
