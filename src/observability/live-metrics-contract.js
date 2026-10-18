import { DAY_MS, exactProductObject, productInstant, requireProductCondition } from './product-delivery-contract.js';

// Fixed dimensions only. Account, Tenant, user and resource identities never enter this report.
export const LIVE_METRICS = Object.freeze({
  neon_transfer: ['providers', 'bytes', 'project_window'],
  render_customer_bandwidth: ['providers', 'megabytes', 'hourly_sample'],
  render_operations_bandwidth: ['providers', 'megabytes', 'hourly_sample'],
  render_customer_memory: ['providers', 'bytes', 'provider_sample'],
  render_operations_memory: ['providers', 'bytes', 'provider_sample'],
  resend_daily_sent: ['providers', 'count', 'provider_window'],
  resend_daily_limit: ['providers', 'count', 'provider_window'],
  resend_monthly_sent: ['providers', 'count', 'provider_window'],
  resend_monthly_limit: ['providers', 'count', 'provider_window'],
  github_ci_total: ['providers', 'count', 'ci_window'],
  github_ci_failed: ['providers', 'count', 'ci_window'],
  tenants: ['product', 'count', 'seeded_state'],
  requests: ['product', 'count', 'seeded_state'],
  requests_updated: ['product', 'count', 'retained_runtime_today'],
  request_revisions: ['product', 'count', 'retained_runtime_today'],
  diagnostic_events: ['product', 'count', 'retained_runtime_today'],
});

export function normalizeLiveMeasurements(input, observedAt) {
  const observed = productInstant(observedAt);
  const ids = Object.keys(LIVE_METRICS);
  requireProductCondition(Array.isArray(input) && input.length === ids.length);
  return Object.freeze(input.map((row, index) => {
    exactProductObject(row, ['id', 'value', 'observedAt', 'periodStart', 'periodEnd', 'sampleAt']);
    requireProductCondition(row.id === ids[index]);
    if (row.value === null) {
      requireProductCondition(row.observedAt === null && row.periodStart === null && row.periodEnd === null && row.sampleAt === null);
    } else {
      requireProductCondition(typeof row.value === 'number' && Number.isFinite(row.value)
        && row.value >= 0 && row.value <= Number.MAX_SAFE_INTEGER
        && (LIVE_METRICS[row.id][1] === 'megabytes' || Number.isSafeInteger(row.value))
        && productInstant(row.observedAt) <= observed
        && observed - productInstant(row.observedAt) < DAY_MS);
      const basis = LIVE_METRICS[row.id][2];
      const sourceTime = productInstant(row.observedAt);
      if (basis === 'hourly_sample' || basis === 'ci_window') {
        const end = Math.floor(sourceTime / 3_600_000) * 3_600_000;
        requireProductCondition(productInstant(row.periodEnd) === end
          && productInstant(row.periodStart) === end - DAY_MS);
      }
      if (basis === 'provider_sample') {
        const end = productInstant(row.periodEnd);
        // Retain older hour-aligned reports while admitting a fine-grained current query.
        requireProductCondition(end <= sourceTime && sourceTime - end < 3_600_000
          && productInstant(row.periodStart) === end - DAY_MS);
      }
      if (basis === 'retained_runtime_today') {
        requireProductCondition(productInstant(row.periodStart) === Math.floor(sourceTime / DAY_MS) * DAY_MS
          && productInstant(row.periodEnd) === sourceTime
          && Math.floor(sourceTime / DAY_MS) === Math.floor(observed / DAY_MS));
      }
      if (basis === 'project_window' || basis === 'provider_window') {
        const end = productInstant(row.periodEnd);
        requireProductCondition(end > sourceTime && end - sourceTime <= 32 * DAY_MS);
        if (row.periodStart !== null) {
          requireProductCondition(end - productInstant(row.periodStart) <= 32 * DAY_MS);
        }
      }
      if (row.id.startsWith('resend_daily_')) {
        const start = Math.floor(sourceTime / DAY_MS) * DAY_MS;
        requireProductCondition(productInstant(row.periodStart) === start
          && [start + DAY_MS - 1, start + DAY_MS].includes(productInstant(row.periodEnd)));
      }
      requireProductCondition(basis === 'hourly_sample' || basis === 'provider_sample'
        ? productInstant(row.sampleAt) <= productInstant(row.observedAt)
          && productInstant(row.sampleAt) >= productInstant(row.periodStart)
          && productInstant(row.sampleAt) <= productInstant(row.periodEnd)
        : row.sampleAt === null);
      if (basis === 'seeded_state') {
        requireProductCondition(row.periodStart === null && row.periodEnd === null);
      } else if (basis === 'provider_window' && row.periodStart === null) {
        requireProductCondition(productInstant(row.periodEnd) > productInstant(row.observedAt));
      } else {
        requireProductCondition(productInstant(row.periodStart) <= productInstant(row.observedAt)
          && productInstant(row.periodStart) < productInstant(row.periodEnd));
        if (LIVE_METRICS[row.id][2] !== 'project_window' && LIVE_METRICS[row.id][2] !== 'provider_window') {
          requireProductCondition(productInstant(row.periodEnd) <= productInstant(row.observedAt));
        }
      }
    }
    return Object.freeze({ ...row });
  }));
}
