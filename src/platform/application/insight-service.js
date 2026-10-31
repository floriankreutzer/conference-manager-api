import { normalizePlatformPrincipal } from '../identity/principal.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { PlatformAuthorizationError } from '../identity/errors.js';

export function createPlatformInsightService({ sources, authorizationPolicy, clock = () => Date.now() } = {}) {
  if (!sources || !['readProvider','readProduct'].every(key => typeof sources[key] === 'function')
    || typeof authorizationPolicy?.authorize !== 'function' || typeof clock !== 'function') {
    throw new TypeError('PLATFORM_INSIGHT_SERVICE_INVALID');
  }
  return Object.freeze({ read({ operatorContext, kind, schemaVersion = 1 }) {
    if (![1,2].includes(schemaVersion) || (schemaVersion === 2 && kind !== 'product-delivery')) {
      throw new TypeError('PLATFORM_INSIGHT_VERSION_INVALID');
    }
    if (!['providers','product-delivery'].includes(kind)) throw new TypeError('PLATFORM_INSIGHT_KIND_INVALID');
    const principal = normalizePlatformPrincipal(operatorContext);
    if (authorizationPolicy.authorize(principal, PLATFORM_PERMISSION.RUNTIME_READ) !== true
      || !['cm:pk:v1','cm:ms:mfa:v1','cm:ms:fresh:v1'].includes(principal.assurance.authenticationContext)) {
      throw new PlatformAuthorizationError();
    }
    // Global provider/product aggregates must never reveal a foreign Tenant
    // through an allowlisted operator's otherwise valid runtime-read access.
    if (principal.targetScope.mode !== 'all') throw new PlatformAuthorizationError();
    if (kind === 'providers' && !principal.roles.includes('platform_security_admin')) throw new PlatformAuthorizationError();
    const now = clock();
    if (schemaVersion === 2) return Object.freeze({ schemaVersion: 2,
      storedReport: sources.readProduct(now), runtimeProduct: sources.readRuntimeProduct?.(now) ?? null });
    return kind === 'providers' ? sources.readProvider(now) : sources.readProduct(now);
  } });
}
