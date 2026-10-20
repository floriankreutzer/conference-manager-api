import { createHmac } from 'node:crypto';
import { createProtectedSessionNamespace } from '../domain/protected-session-namespace.js';

// Server composition selects the purpose and supplies an independent external
// secret. Persistent cipher/lookup keys and abuse-budget keys must stay stable
// across epochs; they must never be passed through this flow-only derivation.
export function deriveProtectedAuthenticationFlowSecret({ secret,environment,securityEpoch,purpose } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret)<32 || Buffer.byteLength(secret)>512
    || /[\u0000-\u001f\u007f]/.test(secret) || !['customer-email-flow','customer-email-code'].includes(purpose)) {
    throw new TypeError('PROTECTED_AUTHENTICATION_FLOW_SECRET_INVALID');
  }
  const namespace=createProtectedSessionNamespace({ environment,securityEpoch });
  return createHmac('sha256',secret).update(`protected-authentication-flow:v1:${purpose}:${namespace}`,'ascii').digest('base64url');
}
