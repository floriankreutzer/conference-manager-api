import { exactProductObject, productInstant, DAY_MS } from '../observability/product-delivery-contract.js';
import { normalizeLiveMeasurements } from '../observability/live-metrics-contract.js';
import { loadDemoProviderUsage } from './platform-provider-usage.js';
import { loadDemoProductDelivery } from './platform-product-delivery.js';

export function normalizeDailyLiveSnapshot(value) {
  exactProductObject(value, ['schemaVersion', 'environment', 'observedAt', 'measurements', 'providerSnapshot', 'productSnapshot']);
  if (value.schemaVersion !== 1 || value.environment !== 'demo') throw new TypeError('LIVE_METRICS_INVALID');
  const time = productInstant(value.observedAt);
  const measurements = normalizeLiveMeasurements(value.measurements, value.observedAt);
  const access = { mode: 'password' };
  const provider = value.providerSnapshot === null ? null : loadDemoProviderUsage({
    DEMO_PROVIDER_USAGE_SNAPSHOT: JSON.stringify(value.providerSnapshot),
  }, access);
  const product = loadDemoProductDelivery({
    DEMO_PRODUCT_DELIVERY_SNAPSHOT: JSON.stringify(value.productSnapshot),
  }, access);
  provider?.read(time);
  product.read(time);
  return Object.freeze({ ...value, measurements, provider, product });
}

// One private object read per five minutes at most; failures cannot refresh observation clocks.
export function createDailyLiveMetrics({ storage, clock = Date.now } = {}) {
  if (typeof storage?.read !== 'function' || typeof clock !== 'function') throw new TypeError('LIVE_METRICS_SOURCE_REQUIRED');
  let cached = null;
  let attemptedAt = null;
  let flight = null;
  let sourceState = 'available';
  async function collect(now) {
    attemptedAt = now;
    try {
      const next = normalizeDailyLiveSnapshot(JSON.parse(await storage.read()));
      if (productInstant(next.observedAt) > clock()
        || (cached && productInstant(next.observedAt) < productInstant(cached.observedAt))) {
        throw new TypeError('LIVE_METRICS_CLOCK_INVALID');
      }
      cached = next;
      sourceState = 'available';
    } catch {
      sourceState = 'last_good';
    }
  }
  return Object.freeze({
    async read() {
      let now = clock();
      if (!Number.isSafeInteger(now) || (attemptedAt !== null && now < attemptedAt)) throw new TypeError('LIVE_METRICS_CLOCK_INVALID');
      const interval = sourceState === 'available' ? 300_000 : 60_000;
      if (attemptedAt === null || now - attemptedAt >= interval) {
        if (!flight) flight = collect(now).finally(() => { flight = null; });
      }
      if (flight) await flight;
      now = clock();
      if (!Number.isSafeInteger(now) || now < attemptedAt) throw new TypeError('LIVE_METRICS_CLOCK_INVALID');
      if (!cached || now < productInstant(cached.observedAt) || now - productInstant(cached.observedAt) >= 30 * DAY_MS) {
        cached = null;
        throw new TypeError('LIVE_METRICS_UNAVAILABLE');
      }
      return Object.freeze({
        schemaVersion: 1, environment: 'demo', collectionMode: 'daily_connector_snapshot',
        observedAt: cached.observedAt, evaluatedAt: new Date(now).toISOString(), sourceState,
        freshness: now - productInstant(cached.observedAt) >= DAY_MS ? 'stale' : 'fresh',
        measurements: cached.measurements,
        providerUsage: cached.provider?.read(now) || null,
        productDelivery: cached.product.read(now),
      });
    },
  });
}
