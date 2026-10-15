import { exactProductObject, productInstant, requireProductCondition } from './product-delivery-contract.js';

// Fixed dimensions only. Account, Tenant, user and resource identities never enter this report.
export const LIVE_METRICS = Object.freeze({
  neon_transfer: ['providers', 'bytes', 'project_window'],
  render_customer_bandwidth: ['providers', 'megabytes', 'hourly_sample'],
  render_operations_bandwidth: ['providers', 'megabytes', 'hourly_sample'],
  render_customer_memory: ['providers', 'bytes', 'hourly_sample'],
  render_operations_memory: ['providers', 'bytes', 'hourly_sample'],
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
        && observed - productInstant(row.observedAt) < 30 * 86_400_000);
      const basis = LIVE_METRICS[row.id][2];
      requireProductCondition(basis === 'hourly_sample'
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
