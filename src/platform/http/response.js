import { PlatformHttpError } from './errors.js';
import { validatePlatformEntraAuthorizationUrl } from '../identity/entra-authorization-url.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function sendPlatformJson(response, statusCode, payload, maxResponseBytes) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxResponseBytes) {
    throw new PlatformHttpError(500, 'PLATFORM_RESPONSE_TOO_LARGE');
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

export function sendPlatformNoContent(response) {
  response.statusCode = 204;
  response.removeHeader('Content-Type');
  response.removeHeader('Content-Length');
  response.end();
}

export function requirePlatformCookie(value, {
  name,
  path,
  sameSite,
} = {}) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 4_096
    || CONTROL_CHARACTERS.test(value)
    || !value.startsWith(`${name}=`)
    || !value.includes(`Path=${path}`)
    || !value.includes('HttpOnly')
    || !value.includes('Secure')
    || !value.includes(`SameSite=${sameSite}`)
    || /(?:^|;)\s*Domain=/i.test(value)
  ) {
    throw new PlatformHttpError(500, 'PLATFORM_COOKIE_CONTRACT_INVALID');
  }
  return value;
}

export function sendPlatformRedirect(response, location, { statusCode = 303 } = {}) {
  if (typeof location !== 'string' || location.length > 4_096 || CONTROL_CHARACTERS.test(location)) {
    throw new PlatformHttpError(500, 'PLATFORM_REDIRECT_INVALID');
  }
  response.statusCode = statusCode;
  response.setHeader('Location', location);
  response.setHeader('Content-Length', '0');
  response.removeHeader('Content-Type');
  response.end();
}

export function requirePlatformProviderAuthorizationUrl(value, authority, {
  clientId,
  redirectUri,
  authenticationContext,
  authenticationMaxAgeSeconds,
} = {}) {
  try {
    return validatePlatformEntraAuthorizationUrl(value, {
      authority,
      clientId,
      redirectUri,
      authenticationContext,
      authenticationMaxAgeSeconds,
    });
  } catch {
    throw new PlatformHttpError(500, 'PLATFORM_AUTHORIZATION_REDIRECT_INVALID');
  }
}

export function requirePlatformResultRedirect(value, publicOrigin) {
  const expected = new URL('/', publicOrigin).toString();
  if (value !== expected) throw new PlatformHttpError(500, 'PLATFORM_RESULT_REDIRECT_INVALID');
  return value;
}
