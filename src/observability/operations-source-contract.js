import { createHash } from 'node:crypto';
import { compileProductDeliveryReport } from './product-delivery-report.js';
import { DAY_MS, exactProductObject as exact, productInstant as instant } from './product-delivery-contract.js';

export const OPERATIONS_SOURCE_KEYS = Object.freeze({
  manual: 'operations/metrics/manual-v1.json',
  feedback: 'operations/feedback/register-v1.json',
});
export const OPERATIONS_SOURCE_MAX_BYTES = 256_000;

function requireSource(condition) {
  if (!condition) throw new TypeError('OPERATIONS_SOURCE_INVALID');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function operationsSourceDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function normalizeOperationsSource(input, kind, now = Date.now(), { freshWrite = false } = {}) {
  requireSource(Object.hasOwn(OPERATIONS_SOURCE_KEYS, kind));
  requireSource(Number.isSafeInteger(now) && now >= 28 * DAY_MS);
  requireSource(Buffer.byteLength(JSON.stringify(input)) <= OPERATIONS_SOURCE_MAX_BYTES);
  exact(input, ['schemaVersion', 'environment', 'kind', 'operatorId', 'recordedAt', 'source']);
  requireSource(input.schemaVersion === 1 && input.environment === 'demo' && input.kind === kind);
  requireSource(typeof input.operatorId === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(input.operatorId));
  const recorded = instant(input.recordedAt);
  requireSource(recorded <= now && now - recorded < (freshWrite ? DAY_MS : 30 * DAY_MS));
  const source = input.source;
  let compilerInput;
  if (kind === 'manual') {
    requireSource(source?.feedbackSource === 'not_configured' && source.feedbackComplete === false
      && Array.isArray(source.feedback) && source.feedback.length === 0);
    compilerInput = source;
  } else {
    exact(source, ['observedAt', 'periodStart', 'periodEnd', 'feedbackSource', 'feedbackComplete', 'feedback']);
    requireSource(source.feedbackSource === 'protected_operator_registry');
    compilerInput = { schemaVersion: 1, environment: 'demo', ...source,
      productComplete: false, productEvents: [],
      deliveryComplete: { application: false, api: false, website: false }, deployments: [] };
  }
  requireSource(compilerInput?.environment === 'demo' && instant(source.observedAt) <= recorded);
  requireSource(recorded - instant(source.observedAt) < DAY_MS);
  compileProductDeliveryReport(compilerInput);
  return Object.freeze(JSON.parse(JSON.stringify(canonical(input))));
}

// Automatic and manual inventories keep independent clocks. A manual source may
// fill unknown facts, but cannot change any immutable or already classified fact.
export function compileOperationsSources(automatic, manual = null, feedback = null, now = Date.now()) {
  requireSource(Number.isSafeInteger(now) && Buffer.byteLength(JSON.stringify(automatic)) <= OPERATIONS_SOURCE_MAX_BYTES);
  requireSource(automatic?.environment === 'demo');
  compileProductDeliveryReport(automatic);
  requireSource(instant(automatic.observedAt) <= now && now - instant(automatic.observedAt) < DAY_MS);
  const merged = structuredClone(automatic);
  const provenance = [];
  function current(envelope, kind) {
    const normalized = normalizeOperationsSource(envelope, kind, now);
    requireSource(normalized.source.periodStart === automatic.periodStart
      && normalized.source.periodEnd === automatic.periodEnd);
    provenance.push({ kind, observedAt: normalized.source.observedAt, recordedAt: normalized.recordedAt,
      digest: operationsSourceDigest(normalized),
      freshness: now - instant(normalized.source.observedAt) >= DAY_MS ? 'stale' : 'fresh' });
    return normalized.source;
  }
  if (manual) {
    const facts = current(manual, 'manual');
    const identities = new Map(merged.deployments.map((event) => [`${event.source}:${event.sourceId}`, event]));
    for (const event of facts.deployments) {
      const known = identities.get(`${event.source}:${event.sourceId}`);
      if (!known) {
        // A complete automatic inventory must never gain older manual deployments.
        requireSource(!automatic.deliveryComplete[event.component]);
        merged.deployments.push(structuredClone(event));
        continue;
      }
      for (const field of ['component', 'artifactCommit', 'deployedAt']) requireSource(known[field] === event[field]);
      for (const field of ['outcome', 'failureAt', 'recoveredAt', 'rework']) {
        const unknown = field === 'outcome' ? 'unknown' : null;
        if (known[field] === unknown) known[field] = event[field];
        else requireSource(event[field] === unknown || known[field] === event[field]);
      }
      if (!known.changes.length) known.changes = structuredClone(event.changes);
      else {
        requireSource(known.changes.length === event.changes.length);
        for (const change of known.changes) {
          const fact = event.changes.find((item) => item.commit === change.commit);
          requireSource(fact && fact.committedAt === change.committedAt);
          if (change.firstSuccessfulDeployment === null) change.firstSuccessfulDeployment = fact.firstSuccessfulDeployment;
          else requireSource(fact.firstSuccessfulDeployment === null
            || change.firstSuccessfulDeployment === fact.firstSuccessfulDeployment);
        }
      }
    }
    for (const component of Object.keys(merged.deliveryComplete)) {
      if (facts.deliveryComplete[component]) {
        const manualIds = new Set(facts.deployments.filter((event) => event.component === component)
          .map((event) => `${event.source}:${event.sourceId}`));
        requireSource(merged.deployments.filter((event) => event.component === component)
          .every((event) => manualIds.has(`${event.source}:${event.sourceId}`)));
        merged.deliveryComplete[component] = true;
      }
    }
    const productIds = new Map(merged.productEvents.map((event) => [`${event.source}:${event.sourceId}`, event]));
    for (const event of facts.productEvents) {
      const known = productIds.get(`${event.source}:${event.sourceId}`);
      if (known) requireSource(operationsSourceDigest(known) === operationsSourceDigest(event));
      else {
        requireSource(!automatic.productComplete);
        merged.productEvents.push(structuredClone(event));
      }
    }
    if (facts.productComplete) {
      const manualIds = new Set(facts.productEvents.map((event) => `${event.source}:${event.sourceId}`));
      requireSource(merged.productEvents.every((event) => manualIds.has(`${event.source}:${event.sourceId}`)));
      merged.productComplete = true;
    }
  }
  if (feedback) {
    const facts = current(feedback, 'feedback');
    // Two configured feedback authorities are ambiguous; never silently replace one.
    requireSource(automatic.feedbackSource === 'not_configured');
    for (const field of ['feedbackSource', 'feedbackComplete', 'feedback']) merged[field] = structuredClone(facts[field]);
  }
  // Preserve the automatic observation clock; separate manual source clocks above
  // never become fresh merely because the daily collector ran again.
  return Object.freeze({ snapshot: compileProductDeliveryReport(merged), sources: provenance });
}
