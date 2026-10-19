import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BROWSER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^\d{8}$/;

function requireContext(context, fields) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(context))) throw new TypeError('EMAIL_CODE_CONTEXT_INVALID');
  const keys = Reflect.ownKeys(context);
  if (keys.length !== fields.length || keys.some((key) => {
    const property = Object.getOwnPropertyDescriptor(context, key);
    return !fields.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value') || !isInternalUuid(property.value);
  })) throw new TypeError('EMAIL_CODE_CONTEXT_INVALID');
  return fields.map((key) => context[key].toLowerCase()).join(':');
}

// Cryptographic primitive only. Durable expiry/attempt limits and atomic redemption belong to the repository/use case.
function createProofFactory({
  secret, environment,
  codeFactory = () => String(randomInt(0, 100_000_000)).padStart(8, '0'),
  browserTokenFactory = () => randomBytes(32).toString('base64url'),
}, { fields, domain }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 512
    || /[\u0000-\u001f\u007f]/.test(secret) || !['dev', 'int', 'prod'].includes(environment)
    || typeof codeFactory !== 'function' || typeof browserTokenFactory !== 'function') {
    throw new TypeError('EMAIL_CODE_CONFIGURATION_INVALID');
  }
  function verifier(purpose, context, value) {
    return createHmac('sha256', secret).update(`${domain}:${environment}:${purpose}:${context}:${value}`, 'ascii')
      .digest('hex');
  }
  return Object.freeze({
    issue(context) {
      const binding = requireContext(context, fields);
      const code = codeFactory();
      const browserToken = browserTokenFactory();
      if (typeof code !== 'string' || !CODE_PATTERN.test(code)
        || typeof browserToken !== 'string' || !BROWSER_PATTERN.test(browserToken)) {
        throw new TypeError('EMAIL_CODE_RANDOM_FACTORY_INVALID');
      }
      return Object.freeze({ code, browserToken,
        codeVerifier: verifier('code', binding, code), browserVerifier: verifier('browser', binding, browserToken) });
    },
    matches({ context, code, browserToken, codeVerifier, browserVerifier } = {}) {
      const binding = requireContext(context, fields);
      if (typeof code !== 'string' || !CODE_PATTERN.test(code)
        || typeof browserToken !== 'string' || !BROWSER_PATTERN.test(browserToken)
        || typeof codeVerifier !== 'string' || !HASH_PATTERN.test(codeVerifier)
        || typeof browserVerifier !== 'string' || !HASH_PATTERN.test(browserVerifier)) return false;
      const codeMatches = timingSafeEqual(Buffer.from(codeVerifier, 'hex'), Buffer.from(verifier('code', binding, code), 'hex'));
      const browserMatches = timingSafeEqual(Buffer.from(browserVerifier, 'hex'),
        Buffer.from(verifier('browser', binding, browserToken), 'hex'));
      return codeMatches && browserMatches;
    },
  });
}

// Existing Tenant/User-bound contract and HMAC domain remain unchanged.
export function createEmailCodeProofFactory(configuration = {}) {
  return createProofFactory(configuration, { fields: ['challengeId', 'tenantId', 'userId'], domain: 'email-code:v1' });
}

// Mailbox ownership evidence only: no Tenant, User, membership, role or provider
// identity is established by this proof. Admission must separately resolve a live
// invitation/membership and consume this proof with session issuance atomically.
export function createEmailMailboxProofFactory(configuration = {}) {
  return createProofFactory(configuration, { fields: ['challengeId', 'mailboxId'], domain: 'email-mailbox-code:v1' });
}
