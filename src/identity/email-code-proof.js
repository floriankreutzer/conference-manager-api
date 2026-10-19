import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BROWSER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^\d{8}$/;

function requireContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || Object.keys(context).length !== 3
    || ['challengeId', 'tenantId', 'userId'].some((key) => !isInternalUuid(context[key]))) {
    throw new TypeError('EMAIL_CODE_CONTEXT_INVALID');
  }
  return [context.challengeId, context.tenantId, context.userId].map((value) => value.toLowerCase()).join(':');
}

// Cryptographic primitive only. Durable expiry/attempt limits and atomic redemption belong to the repository/use case.
export function createEmailCodeProofFactory({
  secret, environment,
  codeFactory = () => String(randomInt(0, 100_000_000)).padStart(8, '0'),
  browserTokenFactory = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 512
    || /[\u0000-\u001f\u007f]/.test(secret) || !['dev', 'int', 'prod'].includes(environment)
    || typeof codeFactory !== 'function' || typeof browserTokenFactory !== 'function') {
    throw new TypeError('EMAIL_CODE_CONFIGURATION_INVALID');
  }
  function verifier(purpose, context, value) {
    return createHmac('sha256', secret).update(`email-code:v1:${environment}:${purpose}:${context}:${value}`, 'ascii')
      .digest('hex');
  }
  return Object.freeze({
    issue(context) {
      const binding = requireContext(context);
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
      const binding = requireContext(context);
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
