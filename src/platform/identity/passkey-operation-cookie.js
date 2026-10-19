const NAME = 'cm_platform_operation_tx';
const PATH = '/api/v1/platform';
const VALUE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

// This temporary cookie must reach the exact business route being signed.
// It is separate from login/enrollment and cannot authorize any operation alone.
export function readPlatformPasskeyOperationCookie(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  const matches = raw.split(';').map(value => value.trim()).filter(value => value.startsWith(`${NAME}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(NAME.length + 1);
  return VALUE.test(value) ? value : null;
}
export function serializePlatformPasskeyOperationCookie(value) {
  if (typeof value !== 'string' || !VALUE.test(value)) throw new TypeError('PLATFORM_PASSKEY_OPERATION_COOKIE_INVALID');
  return `${NAME}=${value}; Path=${PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=120`;
}
export function clearPlatformPasskeyOperationCookie() {
  return `${NAME}=; Path=${PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
