import { compileProductDeliveryReport } from '../observability/product-delivery-report.js';
import { DAY_MS, productInstant } from '../observability/product-delivery-contract.js';

export function createOperationsSourceProjection({ sources, clock = Date.now } = {}) {
  if (typeof sources?.read !== 'function' || typeof clock !== 'function') throw new TypeError('OPERATIONS_SOURCE_CONFIG_INVALID');
  let cached = null;
  let attemptedAt = null;
  let flight = null;
  async function collect(time) {
    attemptedAt = time;
    const rows = [];
    for (const kind of ['manual', 'feedback']) {
      try {
        const value = await sources.read(kind);
        const source = value.envelope.source;
        const input = kind === 'manual' ? source : { schemaVersion: 1, environment: 'demo', ...source,
          productComplete: false, productEvents: [],
          deliveryComplete: { application: false, api: false, website: false }, deployments: [] };
        rows.push({ kind, observedAt: source.observedAt, recordedAt: value.envelope.recordedAt,
          digest: value.digest, sourceState: value.sourceState,
          snapshot: compileProductDeliveryReport(input) });
      } catch {
        rows.push({ kind, observedAt: null, recordedAt: null, digest: null, sourceState: 'unavailable', snapshot: null });
      }
    }
    cached = rows;
  }
  return Object.freeze({ async read() {
    let time = clock();
    if (!Number.isSafeInteger(time) || (attemptedAt !== null && time < attemptedAt)) {
      throw new TypeError('OPERATIONS_SOURCE_CLOCK_INVALID');
    }
    const interval = cached?.some((row) => row.sourceState !== 'available') ? 60_000 : 300_000;
    if (attemptedAt === null || time - attemptedAt >= interval) {
      if (!flight) flight = collect(time).finally(() => { flight = null; });
    }
    if (flight) await flight;
    time = clock();
    if (!Number.isSafeInteger(time) || time < attemptedAt) throw new TypeError('OPERATIONS_SOURCE_CLOCK_INVALID');
    return { schemaVersion: 1, environment: 'demo', evaluatedAt: new Date(time).toISOString(),
      sources: cached.map((row) => {
        if (row.observedAt === null || time - productInstant(row.observedAt) >= 30 * DAY_MS) {
          return { kind: row.kind, observedAt: null, recordedAt: null, digest: null,
            sourceState: 'unavailable', snapshot: null, freshness: 'unknown' };
        }
        if (productInstant(row.observedAt) > time) throw new TypeError('OPERATIONS_SOURCE_CLOCK_INVALID');
        return { ...structuredClone(row), freshness: time - productInstant(row.observedAt) >= DAY_MS ? 'stale' : 'fresh' };
      }),
    };
  } });
}
