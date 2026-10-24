import { evaluateFinopsReport } from './finops-report.js';

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('PLATFORM_PROVIDER_USAGE_CONFIG_INVALID');
  }
}

// Shared private aggregate projection; the caller owns its authentication perimeter.
export function loadProviderUsageSnapshot(raw, { accessMode } = {}) {
  if (!['shared_owner_password', 'application_passkey', 'microsoft_mfa'].includes(accessMode)) {
    throw new TypeError('PLATFORM_PROVIDER_USAGE_CONFIG_INVALID');
  }
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 24000) throw new TypeError('PLATFORM_PROVIDER_USAGE_CONFIG_INVALID');
  let snapshot;
  try { snapshot = JSON.parse(raw); } catch { throw new TypeError('PLATFORM_PROVIDER_USAGE_CONFIG_INVALID'); }
  exact(snapshot, ['schemaVersion', 'plan', 'referenceObservedAt', 'finops']);
  if (snapshot.schemaVersion !== 1 || snapshot.plan !== 'launch_v3'
    || typeof snapshot.referenceObservedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.referenceObservedAt)
    || !Number.isFinite(Date.parse(snapshot.referenceObservedAt))
    || new Date(snapshot.referenceObservedAt).toISOString() !== snapshot.referenceObservedAt) {
    throw new TypeError('PLATFORM_PROVIDER_USAGE_CONFIG_INVALID');
  }
  const report = evaluateFinopsReport(snapshot.finops);
  if (report.measurements.length !== 1 || report.measurements[0].source !== 'database_transfer'
    || report.measurements[0].limit !== 500_000_000_000 || snapshot.finops.rates.length !== 0
    || Date.parse(snapshot.referenceObservedAt) > Date.parse(report.observedAt)) {
    throw new TypeError('PLATFORM_PROVIDER_USAGE_CONFIG_INVALID');
  }
  const usage = report.measurements[0];
  return Object.freeze({
    read(now = Date.now()) {
      if (!Number.isSafeInteger(now) || now < Date.parse(report.observedAt)) {
        throw new TypeError('PLATFORM_PROVIDER_USAGE_CLOCK_INVALID');
      }
      return Object.freeze({
        schemaVersion: 1, collectionMode: 'operator_snapshot', accessMode,
        evaluatedAt: new Date(now).toISOString(), observedAt: report.observedAt,
        periodStart: report.periodStart, periodEnd: report.periodEnd,
        freshness: now - Date.parse(report.observedAt) > 86_400_000 || now >= Date.parse(report.periodEnd)
          ? 'stale' : 'fresh',
        alertDelivery: 'not_configured', costState: 'unknown',
        neon: Object.freeze({ plan: snapshot.plan, source: 'neon_control_plane',
          referenceBasis: 'published_launch_model', referenceObservedAt: snapshot.referenceObservedAt,
          usedBytes: usage.used, referenceBytes: usage.limit, projectedBytes: usage.projected,
          utilizationPercent: usage.utilizationPercent, projectedUtilizationPercent: usage.projectedUtilizationPercent,
          crossedThresholds: usage.crossedThresholds, projectedExhaustion: usage.projectedExhaustion,
          anomalyState: usage.anomaly.state }),
        render: Object.freeze({ usageState: 'unknown_monthly_usage' }),
        github: Object.freeze({ usageState: 'unknown_billing_usage' }),
      });
    },
  });
}
