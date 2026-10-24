import { loadProviderUsageSnapshot } from './provider-usage-snapshot.js';
import { DAY_MS, normalizeProductDeliverySnapshot, productInstant } from './product-delivery-contract.js';
import { uncollectedProductDeliveryReport } from './product-delivery-report.js';

function invalid() { throw new TypeError('PLATFORM_INSIGHT_SNAPSHOT_INVALID'); }
function parse(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 24000) invalid();
  try { return JSON.parse(raw); } catch { invalid(); }
}
// Private, precompiled aggregates only. No provider credentials, network or
// Tenant records enter this source. Missing observations remain unknown.
export function loadProtectedPlatformInsightSnapshots({ providerSnapshot, productSnapshot, accessMode = 'application_passkey' } = {}) {
  const provider = loadProviderUsageSnapshot(providerSnapshot, { accessMode });
  let product = null;
  if (productSnapshot !== undefined) {
    product = normalizeProductDeliverySnapshot(parse(productSnapshot));
    if (product.environment !== 'production' || product.provenance.mode !== 'operator_extract') invalid();
  }
  return Object.freeze({
    readProvider(now) {
      if (!Number.isSafeInteger(now)) invalid();
      if (provider === null) return null;
      return provider.read(now);
    },
    readProduct(now) {
      if (!Number.isSafeInteger(now) || now < 28 * DAY_MS
        || (product && now < productInstant(product.periodEnd))
        || (product?.observedAt && now < productInstant(product.observedAt))) invalid();
      if (product?.observedAt && now - productInstant(product.observedAt) >= 30 * DAY_MS) product = null;
      const report = product || uncollectedProductDeliveryReport(now, 'production');
      return Object.freeze({ ...JSON.parse(JSON.stringify(report)), accessMode,
        collectionMode: report.observedAt === null ? 'not_collected' : 'operator_snapshot',
        evaluatedAt: new Date(now).toISOString(), freshness: report.observedAt === null ? 'unknown'
          : now - productInstant(report.observedAt) >= DAY_MS ? 'stale' : 'fresh' });
    },
  });
}
