import { DAY_MS, exactProductObject, normalizeProductDeliverySnapshot, productInstant,
  requireProductCondition as requireValid } from './product-delivery-contract.js';
import { LIVE_METRICS, normalizeLiveMeasurements } from './live-metrics-contract.js';
import { loadProtectedPlatformInsightSnapshots } from './platform-insight-snapshots.js';

// The existing connector object is a legacy Demo envelope. Only its global
// provider observations and independently compiled Delivery aggregates cross
// this adapter. Seed counts, tenant activity and Demo authority never do.
function normalize(raw, accessMode) {
  requireValid(typeof raw === 'string' && Buffer.byteLength(raw) <= 48000);
  const value = JSON.parse(raw);
  exactProductObject(value, ['schemaVersion', 'environment', 'observedAt', 'measurements', 'providerSnapshot', 'productSnapshot']);
  requireValid(value.schemaVersion === 1 && value.environment === 'demo');
  const observed = productInstant(value.observedAt);
  const measurements = normalizeLiveMeasurements(value.measurements, value.observedAt)
    .filter(row => LIVE_METRICS[row.id][0] === 'providers');
  const product = normalizeProductDeliverySnapshot(value.productSnapshot);
  requireValid(product.environment === 'demo' && product.provenance.mode === 'operator_extract'
    && product.product.every(row => row.value === null) && product.feedback.source === 'not_configured'
    && product.feedback.total === null && productInstant(product.observedAt) <= observed);
  const sources = loadProtectedPlatformInsightSnapshots({ accessMode,
    ...(value.providerSnapshot === null ? {} : { providerSnapshot: JSON.stringify(value.providerSnapshot) }),
    productSnapshot: JSON.stringify({ ...product, environment: 'production' }) });
  // Validate component clocks now, before replacing the previous valid source.
  sources.readProvider(observed);sources.readProduct(observed);
  return { observedAt: value.observedAt, measurements, sources };
}

export function createProtectedDailyInsights({ storage, accessMode, clock = Date.now } = {}) {
  requireValid(typeof storage?.read === 'function' && typeof clock === 'function'
    && ['application_passkey', 'microsoft_mfa'].includes(accessMode));
  let cached = null, attemptedAt = null, flight = null, sourceState = 'available';
  async function collect(now) {
    attemptedAt = now;
    try {
      const next = normalize(await storage.read(), accessMode);
      requireValid(productInstant(next.observedAt) <= clock()
        && (!cached || productInstant(next.observedAt) >= productInstant(cached.observedAt)));
      cached = next;sourceState = 'available';
    } catch { sourceState = 'last_good'; }
  }
  return Object.freeze({ async read() {
    let now = clock();
    requireValid(Number.isSafeInteger(now) && (attemptedAt === null || now >= attemptedAt));
    if (attemptedAt === null || now - attemptedAt >= (sourceState === 'available' ? 300000 : 60000)) {
      if (!flight) flight = collect(now).finally(() => { flight = null; });
    }
    if (flight) await flight;
    now = clock();requireValid(Number.isSafeInteger(now) && now >= attemptedAt);
    if (!cached || now < productInstant(cached.observedAt) || now - productInstant(cached.observedAt) >= 30 * DAY_MS) {
      cached = null;return null;
    }
    return Object.freeze({
      metadata: Object.freeze({ observedAt: cached.observedAt, evaluatedAt: new Date(now).toISOString(), sourceState,
        freshness: now - productInstant(cached.observedAt) >= DAY_MS ? 'stale' : 'fresh' }),
      measurements: cached.measurements, providerUsage: cached.sources.readProvider(now),
      productDelivery: cached.sources.readProduct(now),
    });
  } });
}
