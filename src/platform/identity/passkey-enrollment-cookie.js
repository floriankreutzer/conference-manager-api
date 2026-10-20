export const PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME = 'cm_platform_passkey_enroll';
const TOKEN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const PATH = '/api/v1/platform/auth/passkey/enrollment';

export function readPlatformPasskeyEnrollmentCookie(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME.length + 1);
  return TOKEN.test(value) ? value : null;
}
export function serializePlatformPasskeyEnrollmentCookie(value, maxAgeSeconds = 120) {
  if (!TOKEN.test(value || '') || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300) {
    throw new TypeError('PLATFORM_PASSKEY_ENROLLMENT_COOKIE_INVALID');
  }
  return `${PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME}=${value}; Path=${PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
export function clearPlatformPasskeyEnrollmentCookie() {
  return `${PLATFORM_PASSKEY_ENROLLMENT_COOKIE_NAME}=; Path=${PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
