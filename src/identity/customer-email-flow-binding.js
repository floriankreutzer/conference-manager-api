import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';
import { isCustomerEmailBrowserToken } from './customer-email-browser-token.js';

const HASH = /^[a-f0-9]{64}$/;
function invalid() { throw new TypeError('CUSTOMER_EMAIL_FLOW_BINDING_INVALID'); }
function contextBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Reflect.ownKeys(value);
  if (fields.length !== 2 || fields.some(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !['challengeId','purpose'].includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  }) || !isInternalUuid(value.challengeId) || !['request','choice'].includes(value.purpose)) invalid();
  return `${value.purpose}:${value.challengeId.toLowerCase()}`;
}
function equal(left, right) {
  return typeof left === 'string' && HASH.test(left) && typeof right === 'string' && HASH.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

// Binds both admitted and unadmitted preauthentication transactions to their
// initiating browser. It proves no mailbox, membership, Tenant, role or session.
export function createCustomerEmailFlowBinding({ secret, environment } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512
    || /[\u0000-\u001f\u007f]/.test(secret) || !['dev','int','prod'].includes(environment)) invalid();
  const key = Buffer.from(secret, 'utf8'); let destroyed = false;
  function active() { if (destroyed) throw new Error('CUSTOMER_EMAIL_FLOW_BINDING_UNAVAILABLE'); }
  function verifier(purpose, binding, value) {
    return createHmac('sha256', key).update(`customer-email-flow:v1:${environment}:${purpose}:${binding}:${value}`, 'ascii').digest('hex');
  }
  function csrf(binding, browserVerifier) {
    if (typeof browserVerifier !== 'string' || !HASH.test(browserVerifier)) invalid();
    return verifier('csrf', binding, browserVerifier);
  }
  function bind(context, browserToken) {
    active(); const binding = contextBinding(context);
    if (!isCustomerEmailBrowserToken(browserToken)) invalid();
    const browserVerifier = verifier('browser', binding, browserToken);
    return Object.freeze({ browserVerifier, csrfToken: csrf(binding, browserVerifier) });
  }
  return Object.freeze({
    issue(context) {
      active(); const browserToken = randomBytes(32).toString('base64url');
      return Object.freeze({ browserToken, ...bind(context, browserToken) });
    },
    bind,
    matchesBrowser({ context, browserToken, browserVerifier } = {}) {
      active(); const binding = contextBinding(context);
      if (!isCustomerEmailBrowserToken(browserToken)) return false;
      return equal(browserVerifier, verifier('browser', binding, browserToken));
    },
    csrfFor({ context, browserVerifier } = {}) {
      active(); return csrf(contextBinding(context), browserVerifier);
    },
    verifyCsrf({ context, browserVerifier, csrfToken } = {}) {
      active(); const binding = contextBinding(context);
      if (typeof browserVerifier !== 'string' || !HASH.test(browserVerifier)) return false;
      return equal(csrfToken, csrf(binding, browserVerifier));
    },
    destroy() { destroyed = true; key.fill(0); },
  });
}
