import { normalizeOperationsSource, operationsSourceDigest } from '../observability/operations-source-contract.js';
import { productInstant } from '../observability/product-delivery-contract.js';

export function operationsSourcesEnabled(env, liveStorageConfig) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.keys(env).some((key) => key.startsWith('DEMO_OPERATIONS_SOURCES_')
      && key !== 'DEMO_OPERATIONS_SOURCES_ENABLED')
    || ![undefined, 'false', 'true'].includes(env.DEMO_OPERATIONS_SOURCES_ENABLED)
    || (env.DEMO_OPERATIONS_SOURCES_ENABLED === 'true' && !liveStorageConfig)) {
    throw new TypeError('OPERATIONS_SOURCE_CONFIG_INVALID');
  }
  return env.DEMO_OPERATIONS_SOURCES_ENABLED === 'true';
}

// This port is injected only into the protected operator composition. It is not a
// Tenant service and does not accept keys, URLs, permissions or actor authority.
export function createOperationsSources({ storage, operatorId, clock = Date.now } = {}) {
  if (typeof storage?.read !== 'function' || typeof clock !== 'function'
    || typeof operatorId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(operatorId)) {
    throw new TypeError('OPERATIONS_SOURCE_CONFIG_INVALID');
  }
  const lastGood = new Map();
  let lastClock = null;
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || (lastClock !== null && value < lastClock)) {
      throw new TypeError('OPERATIONS_SOURCE_CLOCK_INVALID');
    }
    lastClock = value;
    return value;
  }
  function decode(stored, kind, time) {
    const envelope = normalizeOperationsSource(JSON.parse(stored.text), kind, time);
    return { envelope, version: stored.version, digest: operationsSourceDigest(envelope) };
  }
  return Object.freeze({
    async read(kind) {
      const time = now();
      try {
        const stored = await storage.read(kind);
        if (!stored) throw new Error('OPERATIONS_SOURCE_MISSING');
        const next = decode(stored, kind, time);
        const previous = lastGood.get(kind);
        if (previous && (productInstant(next.envelope.recordedAt) < productInstant(previous.envelope.recordedAt)
          || productInstant(next.envelope.source.observedAt) < productInstant(previous.envelope.source.observedAt)
          || (next.envelope.recordedAt === previous.envelope.recordedAt && next.digest !== previous.digest))) {
          throw new Error('OPERATIONS_SOURCE_CLOCK_INVALID');
        }
        lastGood.set(kind, next);
        return { ...next, sourceState: 'available' };
      } catch {
        const previous = lastGood.get(kind);
        if (!previous) throw new Error('OPERATIONS_SOURCE_UNAVAILABLE');
        normalizeOperationsSource(previous.envelope, kind, time);
        return { ...previous, sourceState: 'last_good' };
      }
    },
    async write(kind, source, expectedVersion) {
      const time = now();
      const envelope = normalizeOperationsSource({ schemaVersion: 1, environment: 'demo', kind, operatorId,
        recordedAt: new Date(time).toISOString(), source }, kind, time, { freshWrite: true });
      // A failed provider read cannot be interpreted as an absent object.
      const stored = await storage.read(kind);
      const previous = stored ? decode(stored, kind, time) : null;
      if (!previous && kind === 'feedback' && source.feedbackComplete && source.feedback.length === 0) {
        throw new TypeError('OPERATIONS_SOURCE_NEW_REGISTER_INCOMPLETE');
      }
      if (previous && operationsSourceDigest(previous.envelope.source) === operationsSourceDigest(source)) {
        return { version: previous.version, digest: previous.digest, duplicate: true };
      }
      if ((previous?.version ?? null) !== expectedVersion) throw new Error('OPERATIONS_SOURCE_CONFLICT');
      if (previous && (productInstant(envelope.recordedAt) <= productInstant(previous.envelope.recordedAt)
        || productInstant(source.observedAt) < productInstant(previous.envelope.source.observedAt))) {
        throw new Error('OPERATIONS_SOURCE_CLOCK_INVALID');
      }
      if (typeof storage.write !== 'function') throw new Error('OPERATIONS_SOURCE_WRITE_FORBIDDEN');
      const result = await storage.write(kind, JSON.stringify(envelope), expectedVersion);
      return { version: result.version, digest: operationsSourceDigest(envelope), duplicate: false };
    },
  });
}
