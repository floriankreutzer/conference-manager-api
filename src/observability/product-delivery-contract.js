export const PRODUCT_METRIC_IDS = Object.freeze([
  'onboarding_started',
  'onboarding_completed',
  'request_started',
  'request_submitted',
  'request_abandoned',
  'time_to_submit',
  'manager_decisions',
  'manager_decision_time',
  'transition_failures',
  'recovery_completed',
  'recovery_failed',
]);
export const DELIVERY_METRIC_IDS = Object.freeze([
  'change_lead_time',
  'deployment_frequency',
  'failed_deployment_recovery_time',
  'change_failure_rate',
  'deployment_rework_rate',
]);
export const DELIVERY_COMPONENTS = Object.freeze(['application', 'api', 'website']);
export const FEEDBACK_CATEGORIES = Object.freeze([
  'usability',
  'correctness',
  'performance',
  'accessibility',
  'integration',
]);
export const FEEDBACK_WORKFLOWS = Object.freeze(['onboarding', 'request', 'manager', 'recovery']);
export const FEEDBACK_SENTIMENTS = Object.freeze(['positive', 'neutral', 'negative']);
export const DAY_MS = 86_400_000;
const REASONS = new Set([
  'available',
  'incomplete_source',
  'missing_start_clock',
  'empty_denominator',
  'unresolved_recovery',
  'missing_classification',
  'not_configured',
]);

export function requireProductCondition(condition) {
  if (!condition) throw new TypeError('PRODUCT_DELIVERY_INVALID');
}

export function exactProductObject(value, keys) {
  requireProductCondition(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );
}

export function productInstant(value) {
  requireProductCondition(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
  return Date.parse(value);
}

export function productMetric(id, value = null, reason = 'incomplete_source') {
  const unit = id.endsWith('_rate')
    ? 'ratio'
    : [
          'time_to_submit',
          'manager_decision_time',
          'change_lead_time',
          'failed_deployment_recovery_time',
        ].includes(id)
      ? 'milliseconds'
      : 'count';
  return Object.freeze({ id, unit, value, reason: value === null ? reason : 'available' });
}

function metrics(value, ids) {
  requireProductCondition(Array.isArray(value) && value.length === ids.length);
  value.forEach((metric, index) => {
    exactProductObject(metric, ['id', 'unit', 'value', 'reason']);
    const expected = productMetric(ids[index]);
    requireProductCondition(
      metric.id === expected.id &&
        metric.unit === expected.unit &&
        REASONS.has(metric.reason) &&
        (metric.value === null
          ? metric.reason !== 'available'
          : typeof metric.value === 'number' &&
            Number.isFinite(metric.value) &&
            metric.value >= 0 &&
            metric.value <= Number.MAX_SAFE_INTEGER &&
            metric.reason === 'available' &&
            (metric.unit !== 'count' ||
              (Number.isSafeInteger(metric.value) && metric.value <= 2000)) &&
            (metric.unit !== 'ratio' || metric.value <= 1)),
    );
  });
}

export function normalizeProductDeliverySnapshot(value) {
  exactProductObject(value, [
    'schemaVersion',
    'environment',
    'observedAt',
    'periodStart',
    'periodEnd',
    'product',
    'feedback',
    'delivery',
    'provenance',
  ]);
  requireProductCondition(
    value.schemaVersion === 1 && ['demo', 'production'].includes(value.environment),
  );
  const start = productInstant(value.periodStart);
  const end = productInstant(value.periodEnd);
  requireProductCondition(end - start === 28 * DAY_MS && start % DAY_MS === 0);
  if (value.observedAt !== null)
    requireProductCondition(
      productInstant(value.observedAt) >= end && productInstant(value.observedAt) - end <= DAY_MS,
    );
  metrics(value.product, PRODUCT_METRIC_IDS);
  for (const id of ['request_started', 'request_abandoned', 'time_to_submit']) {
    const item = value.product.find((entry) => entry.id === id);
    requireProductCondition(item.value === null && item.reason === 'missing_start_clock');
  }
  exactProductObject(value.feedback, [
    'source',
    'total',
    'open',
    'highSeverity',
    'categories',
    'workflows',
    'sentiments',
  ]);
  requireProductCondition(
    ['not_configured', 'protected_operator_registry'].includes(value.feedback.source),
  );
  const counts = [value.feedback.total, value.feedback.open, value.feedback.highSeverity];
  requireProductCondition(
    counts.every(
      (count) => count === null || (Number.isSafeInteger(count) && count >= 0 && count <= 200),
    ),
  );
  requireProductCondition(
    counts.every((count) => count === null) ||
      (counts.every((count) => count !== null) && counts[1] <= counts[0] && counts[2] <= counts[0]),
  );
  if (value.feedback.source === 'not_configured')
    requireProductCondition(counts.every((count) => count === null));
  for (const [name, ids] of [
    ['categories', FEEDBACK_CATEGORIES],
    ['workflows', FEEDBACK_WORKFLOWS],
    ['sentiments', FEEDBACK_SENTIMENTS],
  ]) {
    const groups = value.feedback[name];
    requireProductCondition(Array.isArray(groups) && groups.length === ids.length);
    groups.forEach((group, index) => {
      exactProductObject(group, ['id', 'count']);
      requireProductCondition(
        group.id === ids[index] &&
          (counts[0] === null
            ? group.count === null
            : Number.isSafeInteger(group.count) && group.count >= 0 && group.count <= counts[0]),
      );
    });
    if (counts[0] !== null)
      requireProductCondition(groups.reduce((sum, group) => sum + group.count, 0) === counts[0]);
  }

  requireProductCondition(
    Array.isArray(value.delivery) && value.delivery.length === DELIVERY_COMPONENTS.length,
  );
  value.delivery.forEach((component, index) => {
    exactProductObject(component, ['component', 'buckets']);
    requireProductCondition(
      component.component === DELIVERY_COMPONENTS[index] &&
        Array.isArray(component.buckets) &&
        component.buckets.length === 4,
    );
    component.buckets.forEach((bucket, offset) => {
      exactProductObject(bucket, ['periodStart', 'periodEnd', 'metrics', 'unresolvedRecoveries']);
      requireProductCondition(
        productInstant(bucket.periodStart) === start + offset * 7 * DAY_MS &&
          productInstant(bucket.periodEnd) === start + (offset + 1) * 7 * DAY_MS,
      );
      metrics(bucket.metrics, DELIVERY_METRIC_IDS);
      requireProductCondition(
        bucket.unresolvedRecoveries === null ||
          (Number.isSafeInteger(bucket.unresolvedRecoveries) &&
            bucket.unresolvedRecoveries >= 0 &&
            bucket.unresolvedRecoveries <= 2000),
      );
      if (bucket.unresolvedRecoveries > 0)
        requireProductCondition(bucket.metrics[2].value === null);
      const deploymentCount = bucket.metrics[1].value;
      if (deploymentCount === null)
        requireProductCondition(
          bucket.unresolvedRecoveries === null &&
            bucket.metrics.every((item) => item.value === null),
        );
      if (deploymentCount === 0)
        requireProductCondition(
          [0, 2, 3, 4].every((index) => bucket.metrics[index].value === null),
        );
      if (bucket.unresolvedRecoveries !== null && deploymentCount !== null) {
        requireProductCondition(bucket.unresolvedRecoveries <= deploymentCount);
      }
    });
  });
  exactProductObject(value.provenance, ['mode', 'sourceDigest', 'eventCount']);
  requireProductCondition(
    ['not_collected', 'operator_extract'].includes(value.provenance.mode) &&
      Number.isSafeInteger(value.provenance.eventCount) &&
      value.provenance.eventCount >= 0 &&
      value.provenance.eventCount <= 4200,
  );
  requireProductCondition(
    value.provenance.mode === 'not_collected'
      ? value.provenance.sourceDigest === null &&
          value.observedAt === null &&
          value.provenance.eventCount === 0 &&
          value.product.every((metric) => metric.value === null) &&
          value.feedback.total === null &&
          value.delivery.every((component) =>
            component.buckets.every(
              (bucket) =>
                bucket.metrics.every((metric) => metric.value === null) &&
                bucket.unresolvedRecoveries === null,
            ),
          )
      : typeof value.provenance.sourceDigest === 'string' &&
          /^[a-f0-9]{64}$/.test(value.provenance.sourceDigest) &&
          value.observedAt !== null,
  );
  const knownProductEvents = value.product
    .filter((item) => item.unit === 'count')
    .reduce((sum, item) => sum + (item.value || 0), 0);
  const knownDeployments = value.delivery.reduce(
    (sum, component) =>
      sum + component.buckets.reduce((count, bucket) => count + (bucket.metrics[1].value || 0), 0),
    0,
  );
  requireProductCondition(
    knownProductEvents + knownDeployments + (value.feedback.total || 0) <=
      value.provenance.eventCount,
  );
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}
