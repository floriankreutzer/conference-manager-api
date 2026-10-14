import {
  DAY_MS,
  normalizeProductDeliverySnapshot,
  productInstant,
} from '../observability/product-delivery-contract.js';
import { uncollectedProductDeliveryReport } from '../observability/product-delivery-report.js';

export function loadDemoProductDelivery(env, accessSettings) {
  if (
    !env ||
    typeof env !== 'object' ||
    Array.isArray(env) ||
    Object.keys(env).some(
      (key) => key.startsWith('DEMO_PRODUCT_DELIVERY_') && key !== 'DEMO_PRODUCT_DELIVERY_SNAPSHOT',
    )
  )
    throw new TypeError('DEMO_PRODUCT_DELIVERY_CONFIG_INVALID');
  const raw = env.DEMO_PRODUCT_DELIVERY_SNAPSHOT;
  if (accessSettings?.mode !== 'password') {
    if (raw !== undefined) throw new TypeError('DEMO_PRODUCT_DELIVERY_PRIVATE_ACCESS_REQUIRED');
    return null;
  }
  let snapshot = null;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.length > 24_000)
      throw new TypeError('DEMO_PRODUCT_DELIVERY_CONFIG_INVALID');
    try {
      snapshot = normalizeProductDeliverySnapshot(JSON.parse(raw));
      if (snapshot.environment !== 'demo' || snapshot.provenance.mode !== 'operator_extract')
        throw new TypeError('SNAPSHOT_SOURCE_REQUIRED');
    } catch {
      throw new TypeError('DEMO_PRODUCT_DELIVERY_CONFIG_INVALID');
    }
  }
  return Object.freeze({
    read(now = Date.now()) {
      if (
        !Number.isSafeInteger(now) ||
        now < 28 * DAY_MS ||
        (snapshot && now < productInstant(snapshot.periodEnd)) ||
        (snapshot?.observedAt && now < productInstant(snapshot.observedAt))
      ) {
        throw new TypeError('DEMO_PRODUCT_DELIVERY_CLOCK_INVALID');
      }
      // Logical expiry also removes the retained in-process aggregate. Operational
      // configuration/source retention remains an explicit operator obligation.
      if (snapshot?.observedAt && now - productInstant(snapshot.observedAt) >= 30 * DAY_MS)
        snapshot = null;
      const report = snapshot || uncollectedProductDeliveryReport(now);
      return Object.freeze({
        ...JSON.parse(JSON.stringify(report)),
        collectionMode: report.observedAt === null ? 'not_collected' : 'operator_snapshot',
        accessMode: 'shared_owner_password',
        evaluatedAt: new Date(now).toISOString(),
        freshness:
          report.observedAt === null
            ? 'unknown'
            : now - productInstant(report.observedAt) >= DAY_MS
              ? 'stale'
              : 'fresh',
      });
    },
  });
}
