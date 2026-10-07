import { evaluateTransferBudget } from './transfer-budget.js';

const RATE_PROVENANCE = new Set(['neon_published', 'render_published', 'github_published', 'operator_contract']);
const CURRENCIES = new Set(['USD', 'EUR']);
const MIN_BASELINE_INTERVALS = 7;

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('FINOPS_REPORT_SCHEMA_INVALID');
  }
}

function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError('FINOPS_REPORT_AMOUNT_INVALID');
  return value;
}

function intervalRate(previous, current, source) {
  const before = previous.measurements.find((item) => item.source === source);
  const after = current.measurements.find((item) => item.source === source);
  if (!before || !after || before.unit !== after.unit || before.limit !== after.limit
    || after.used < before.used) throw new TypeError('FINOPS_REPORT_HISTORY_INVALID');
  const seconds = (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) / 1000;
  if (seconds < 60) throw new TypeError('FINOPS_REPORT_HISTORY_INTERVAL_INVALID');
  return (after.used - before.used) / seconds;
}

function anomaly(history, current, source) {
  if (history.length < MIN_BASELINE_INTERVALS + 1) return Object.freeze({ state: 'insufficient_baseline' });
  const rates = [];
  for (let index = 1; index < history.length; index += 1) {
    rates.push(intervalRate(history[index - 1], history[index], source));
  }
  rates.sort((left, right) => left - right);
  const middle = Math.floor(rates.length / 2);
  const median = rates.length % 2 === 0 ? (rates[middle - 1] + rates[middle]) / 2 : rates[middle];
  const latestRate = intervalRate(history.at(-1), current, source);
  const unit = current.measurements.find((item) => item.source === source).unit;
  // Explicit candidate policy: 3x median, above a minimum material increment/day.
  const minimum = (unit === 'bytes' ? 1_000_000 : 60) / 86_400;
  return Object.freeze({ state: latestRate > Math.max(median * 3, minimum) ? 'anomaly' : 'within_candidate_baseline',
    medianPerSecond: median, latestPerSecond: latestRate, method: 'interval_rate_three_times_median' });
}

function cost(usage, tariff, observedAt) {
  if (!tariff) return Object.freeze({ state: 'unknown_rate' });
  exact(tariff, ['source', 'currency', 'priceMicrosPerUnit', 'unitSize', 'included', 'rateObservedAt', 'provenance']);
  if (!CURRENCIES.has(tariff.currency) || !RATE_PROVENANCE.has(tariff.provenance)) {
    throw new TypeError('FINOPS_REPORT_RATE_INVALID');
  }
  integer(tariff.priceMicrosPerUnit); integer(tariff.unitSize, 1); integer(tariff.included);
  const epoch = Date.parse(tariff.rateObservedAt);
  if (typeof tariff.rateObservedAt !== 'string' || !Number.isFinite(epoch)
    || new Date(epoch).toISOString() !== tariff.rateObservedAt || epoch > Date.parse(observedAt)) {
    throw new TypeError('FINOPS_REPORT_RATE_DATE_INVALID');
  }
  const amount = (used) => {
    const numerator = BigInt(Math.max(0, used - tariff.included)) * BigInt(tariff.priceMicrosPerUnit);
    const denominator = BigInt(tariff.unitSize);
    const result = Number((numerator + denominator - 1n) / denominator);
    return integer(result);
  };
  return Object.freeze({ state: 'estimated_metered_component', currency: tariff.currency,
    actualUsageCostMicros: amount(usage.used), projectedUsageCostMicros: amount(usage.projected),
    provenance: tariff.provenance, rateObservedAt: tariff.rateObservedAt });
}

// Offline operator evidence only. It neither reads provider accounts nor delivers messages.
export function evaluateFinopsReport(input) {
  exact(input, ['schemaVersion', 'current', 'history', 'rates']);
  if (input.schemaVersion !== 1 || !Array.isArray(input.history) || input.history.length > 32
    || !Array.isArray(input.rates) || input.rates.length > 4) throw new TypeError('FINOPS_REPORT_INPUT_INVALID');
  const current = evaluateTransferBudget(input.current);
  const history = input.history.map(evaluateTransferBudget);
  const sources = current.measurements.map((item) => item.source);
  let previous = null;
  for (const snapshot of [...history, current]) {
    if (snapshot.periodStart !== current.periodStart || snapshot.periodEnd !== current.periodEnd
      || snapshot.measurements.length !== sources.length
      || snapshot.measurements.some((item) => !sources.includes(item.source))) {
      throw new TypeError('FINOPS_REPORT_HISTORY_WINDOW_INVALID');
    }
    if (previous) for (const source of sources) intervalRate(previous, snapshot, source);
    previous = snapshot;
  }
  const tariffs = new Map();
  for (const tariff of input.rates) {
    if (!tariff || !sources.includes(tariff.source) || tariffs.has(tariff.source)) {
      throw new TypeError('FINOPS_REPORT_RATE_SOURCE_INVALID');
    }
    tariffs.set(tariff.source, tariff);
  }
  const measurements = current.measurements.map((usage) => {
    const before = history.at(-1)?.measurements.find((item) => item.source === usage.source);
    const newThresholds = usage.crossedThresholds.filter((threshold) => !before?.crossedThresholds.includes(threshold));
    const anomalyState = anomaly(history, current, usage.source);
    return Object.freeze({ ...usage, newThresholds: Object.freeze(newThresholds), anomaly: anomalyState,
      cost: cost(usage, tariffs.get(usage.source), current.observedAt) });
  });
  return Object.freeze({ schemaVersion: 1, periodStart: current.periodStart, periodEnd: current.periodEnd,
    observedAt: current.observedAt, forecastMethod: current.forecastMethod,
    costBasis: 'provided_metered_rates_excluding_fixed_compute_storage_tax_and_tiers',
    alertDelivery: 'report_only', measurements: Object.freeze(measurements) });
}

export function renderFinopsDashboard(report) {
  // Validate before rendering: no caller-provided string becomes HTML.
  const names = { database_transfer: 'Database transfer', application_egress: 'Application egress',
    object_storage_egress: 'Object storage egress', ci_runtime: 'CI runtime' };
  if (report?.schemaVersion !== 1 || !Array.isArray(report.measurements) || report.measurements.length > 4) {
    throw new TypeError('FINOPS_DASHBOARD_INVALID');
  }
  const timestamps = [report.periodStart, report.periodEnd, report.observedAt];
  if (timestamps.some((value) => typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) {
    throw new TypeError('FINOPS_DASHBOARD_INVALID');
  }
  const rows = report.measurements.map((item) => {
    if (!Object.hasOwn(names, item.source) || !['bytes', 'seconds'].includes(item.unit)
      || !Array.isArray(item.newThresholds) || item.newThresholds.some((value) => ![50, 70, 85, 95].includes(value))) {
      throw new TypeError('FINOPS_DASHBOARD_INVALID');
    }
    integer(item.used); integer(item.limit, 1); integer(item.projected);
    const signal = item.anomaly?.state === 'anomaly' ? 'Anomaly candidate' :
      item.anomaly?.state === 'within_candidate_baseline' ? 'Within candidate baseline' : 'Baseline incomplete';
    let price = 'Unknown rate';
    if (item.cost?.state === 'estimated_metered_component') {
      if (!CURRENCIES.has(item.cost.currency)) throw new TypeError('FINOPS_DASHBOARD_INVALID');
      integer(item.cost.actualUsageCostMicros); integer(item.cost.projectedUsageCostMicros);
      price = `${item.cost.currency} ${(item.cost.actualUsageCostMicros / 1_000_000).toFixed(6)} / `
        + `${(item.cost.projectedUsageCostMicros / 1_000_000).toFixed(6)} projected`;
    }
    return `<tr><th scope="row">${names[item.source]}</th><td>${item.used} ${item.unit}</td>`
      + `<td>${item.limit} ${item.unit}</td><td>${item.projected} ${item.unit}</td>`
      + `<td>${item.newThresholds.join(', ') || 'None'}%</td><td>${signal}</td><td>${price}</td></tr>`;
  }).join('');
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + '<title>Transfer budget evidence</title><style>body{font:1rem system-ui;margin:2rem;line-height:1.5}'
    + 'table{border-collapse:collapse}th,td{padding:.6rem;text-align:left;border:1px solid #bbb}'
    + '.table{overflow-x:auto}p{max-width:70ch}</style><main><h1>Transfer budget evidence</h1>'
    + `<p>Window: ${timestamps[0]} to ${timestamps[1]}. Observed: ${timestamps[2]}.</p>`
    + '<p>Offline aggregate evidence. Forecasts and metered cost components are estimates; sources are not added. '
    + 'This report does not send alerts, change quotas or prove production capacity.</p><div class="table">'
    + '<table><caption>Observed totals, budgets and separate projections</caption><thead><tr>'
    + '<th scope="col">Source</th><th scope="col">Observed</th><th scope="col">Budget</th>'
    + '<th scope="col">Linear projection</th><th scope="col">New thresholds</th>'
    + '<th scope="col">Rate signal</th><th scope="col">Metered cost component</th></tr></thead>'
    + `<tbody>${rows}</tbody></table></div><p>Missing usage remains unknown. A baseline requires seven prior `
    + 'intervals. Fixed fees, compute, storage, tax and tiered tariffs are excluded.</p></main></html>\n';
}
