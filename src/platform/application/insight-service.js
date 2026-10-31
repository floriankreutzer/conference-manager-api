import { normalizePlatformPrincipal } from '../identity/principal.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { PlatformAuthorizationError } from '../identity/errors.js';

export function createPlatformInsightService({ sources, dailyInsights = null, authorizationPolicy, clock = () => Date.now() } = {}) {
  if (!sources || !['readProvider','readProduct'].every(key => typeof sources[key] === 'function')
    || typeof authorizationPolicy?.authorize !== 'function' || typeof clock !== 'function'
    || (dailyInsights !== null && typeof dailyInsights.read !== 'function')) {
    throw new TypeError('PLATFORM_INSIGHT_SERVICE_INVALID');
  }
  async function readDaily(kind, now) {
    const daily = await dailyInsights?.read() ?? null;
    const dailyState = daily?.metadata.sourceState ?? (dailyInsights ? 'unavailable' : 'not_configured');
    if (kind === 'providers') return Object.freeze({ schemaVersion: 2, dailyState,
      providerUsage: daily ? daily.providerUsage : sources.readProvider(now),
      daily: daily ? Object.freeze({ ...daily.metadata, measurements: daily.measurements }) : null });
    return Object.freeze({ schemaVersion: 3, dailyState, daily: daily?.metadata ?? null,
      storedReport: daily ? daily.productDelivery : sources.readProduct(now),
      runtimeProduct: sources.readRuntimeProduct?.(now) ?? null });
  }
  return Object.freeze({ read({ operatorContext, kind, schemaVersion = 1 }) {
    if (![1,2,3].includes(schemaVersion) || (schemaVersion === 3 && kind !== 'product-delivery')) {
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
    if (schemaVersion === 3 || schemaVersion === 2 && kind === 'providers') return readDaily(kind, now);
    if (schemaVersion === 2) return Object.freeze({ schemaVersion: 2,
      storedReport: sources.readProduct(now), runtimeProduct: sources.readRuntimeProduct?.(now) ?? null });
    return kind === 'providers' ? sources.readProvider(now) : sources.readProduct(now);
  } });
}
