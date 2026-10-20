import { isInternalUuid } from '../domain/identifiers.js';

const PATTERN=/^protected-v1:(?:dev|int|prod):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isProtectedCustomerSessionNamespace(value) { return typeof value==='string' && PATTERN.test(value); }

export function createProtectedCustomerSessionNamespace({ environment,securityEpoch }={}) {
  if (!['dev','int','prod'].includes(environment) || !isInternalUuid(securityEpoch)) {
    throw new TypeError('PROTECTED_CUSTOMER_SESSION_NAMESPACE_INVALID');
  }
  return `protected-v1:${environment}:${securityEpoch.toLowerCase()}`;
}
