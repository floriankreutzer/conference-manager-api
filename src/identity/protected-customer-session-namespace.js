import { createProtectedSessionNamespace } from '../domain/protected-session-namespace.js';
export { isProtectedSessionNamespace as isProtectedCustomerSessionNamespace } from '../domain/protected-session-namespace.js';

export function createProtectedCustomerSessionNamespace({ environment,securityEpoch }={}) {
  try { return createProtectedSessionNamespace({ environment,securityEpoch }); }
  catch {
    throw new TypeError('PROTECTED_CUSTOMER_SESSION_NAMESPACE_INVALID');
  }
}
