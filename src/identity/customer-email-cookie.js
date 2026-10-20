import { isInternalUuid } from '../domain/identifiers.js';
import { isCustomerEmailBrowserToken } from './customer-email-browser-token.js';

export const CUSTOMER_EMAIL_COOKIE_NAME = 'cm_customer_email_tx';
const PATH = '/api/v1/auth/email';
function attributes(maxAgeSeconds) {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 900) {
    throw new TypeError('CUSTOMER_EMAIL_COOKIE_LIFETIME_INVALID');
  }
  return `Path=${PATH}; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAgeSeconds}`;
}
function parse(value) {
  if (typeof value !== 'string' || value.length !== 80) return null;
  const [challengeId,browserToken,...extra] = value.split('.');
  if (extra.length || !isInternalUuid(challengeId) || challengeId !== challengeId.toLowerCase()
    || !isCustomerEmailBrowserToken(browserToken)) return null;
  return Object.freeze({ challengeId,browserToken });
}
export function readCustomerEmailTransactionCookie(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 8192) return null;
  let result = null;
  for (const part of raw.split(';')) {
    const index = part.indexOf('='); if (index < 1 || part.slice(0,index).trim() !== CUSTOMER_EMAIL_COOKIE_NAME) continue;
    if (result !== null) return null;
    result = parse(part.slice(index+1).trim()); if (result === null) return null;
  }
  return result;
}
export function serializeCustomerEmailTransactionCookie({ challengeId,browserToken } = {}, { maxAgeSeconds } = {}) {
  if (!isInternalUuid(challengeId) || !isCustomerEmailBrowserToken(browserToken) || maxAgeSeconds === 0) {
    throw new TypeError('CUSTOMER_EMAIL_COOKIE_INVALID');
  }
  return `${CUSTOMER_EMAIL_COOKIE_NAME}=${challengeId.toLowerCase()}.${browserToken}; ${attributes(maxAgeSeconds)}`;
}
export function clearCustomerEmailTransactionCookie() {
  return `${CUSTOMER_EMAIL_COOKIE_NAME}=; ${attributes(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
