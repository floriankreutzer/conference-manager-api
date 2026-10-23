import { loadProviderUsageSnapshot } from '../observability/provider-usage-snapshot.js';

// Private operator snapshot only: no provider credentials, account identifiers or outbound transport.
export function loadDemoProviderUsage(env, accessSettings) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.keys(env).some((key) => key.startsWith('DEMO_PROVIDER_USAGE_')
      && key !== 'DEMO_PROVIDER_USAGE_SNAPSHOT')) throw new TypeError('DEMO_PROVIDER_USAGE_CONFIG_INVALID');
  const raw = env?.DEMO_PROVIDER_USAGE_SNAPSHOT;
  if (raw === undefined) return null;
  if (accessSettings?.mode !== 'password' || typeof raw !== 'string' || raw.length > 24_000) {
    throw new TypeError('DEMO_PROVIDER_USAGE_CONFIG_INVALID');
  }
  let source;
  try { source = loadProviderUsageSnapshot(raw, { accessMode: 'shared_owner_password' }); }
  catch { throw new TypeError('DEMO_PROVIDER_USAGE_CONFIG_INVALID'); }
  return Object.freeze({ read(now = Date.now()) {
    try { return source.read(now); } catch { throw new TypeError('DEMO_PROVIDER_USAGE_CLOCK_INVALID'); }
  } });
}
