export const PLATFORM_SESSION_COOKIE_NAME = 'cm_platform_session';
export const PLATFORM_SESSION_COOKIE_PATH = '/api/v1/platform';
export const PLATFORM_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hasPlatformSessionCookie(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string') return false;
  return raw.split(';').some((part) => (
    part.split('=', 1)[0].trim() === PLATFORM_SESSION_COOKIE_NAME
  ));
}

function cookie(token, { secure, maxAgeSeconds, expires }) {
  const attributes = [
    `${PLATFORM_SESSION_COOKIE_NAME}=${token}`,
    `Path=${PLATFORM_SESSION_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attributes.push('Secure');
  if (maxAgeSeconds !== undefined) attributes.push(`Max-Age=${maxAgeSeconds}`);
  if (expires) attributes.push(`Expires=${expires}`);
  return attributes.join('; ');
}

export function serializePlatformSessionCookie(token, { secure, maxAgeSeconds } = {}) {
  if (!PLATFORM_SESSION_TOKEN_PATTERN.test(token || '')) throw new TypeError('PLATFORM_SESSION_TOKEN_INVALID');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new TypeError('PLATFORM_SESSION_COOKIE_MAX_AGE_INVALID');
  }
  return cookie(token, { secure: secure === true, maxAgeSeconds });
}

export function serializeClearedPlatformSessionCookie({ secure } = {}) {
  return cookie('', {
    secure: secure === true,
    maxAgeSeconds: 0,
    expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
  });
}

export function readPlatformSessionToken(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string') return null;
  const values = raw.split(';').map((part) => part.trim()).filter((part) => {
    return part.startsWith(`${PLATFORM_SESSION_COOKIE_NAME}=`);
  });
  if (values.length !== 1) return null;
  const token = values[0].slice(PLATFORM_SESSION_COOKIE_NAME.length + 1);
  return PLATFORM_SESSION_TOKEN_PATTERN.test(token) ? token : null;
}
