import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateFinopsReport, renderFinopsDashboard } from '../src/observability/finops-report.js';

function snapshot(day, used, limit = 100_000_000) {
  return { schemaVersion: 1, periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z',
    observedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    measurements: [{ source: 'database_transfer', unit: 'bytes', used, limit }] };
}

function input() {
  return { schemaVersion: 1, current: snapshot(16, 95_000_000), history: [snapshot(15, 70_000_000)], rates: [{
    source: 'database_transfer', currency: 'USD', priceMicrosPerUnit: 100_000, unitSize: 1_000_000_000,
    included: 80_000_000, rateObservedAt: '2026-10-07T00:00:00.000Z', provenance: 'neon_published',
  }] };
}

test('FinOps reports only newly crossed signals and independent exact metered cost components', () => {
  const report = evaluateFinopsReport(input());
  const value = report.measurements[0];
  assert.deepEqual(value.newThresholds, [85, 95]);
  assert.equal(value.cost.actualUsageCostMicros, 1500);
  assert.equal(value.cost.currency, 'USD');
  assert.equal(value.anomaly.state, 'insufficient_baseline');
  assert.equal(report.alertDelivery, 'report_only');
  assert.equal(report.totalCost, undefined);
  const continued = input(); continued.current = snapshot(17, 96_000_000); continued.history = [input().current];
  assert.deepEqual(evaluateFinopsReport(continued).measurements[0].newThresholds, []);
  continued.rates = [];
  assert.equal(evaluateFinopsReport(continued).measurements[0].cost.state, 'unknown_rate');
});

test('anomaly candidates require seven comparable baseline intervals and a material rate increase', () => {
  const history = Array.from({ length: 8 }, (_, index) => snapshot(index + 2, (index + 1) * 1_000_000));
  const report = evaluateFinopsReport({ schemaVersion: 1, current: snapshot(10, 18_000_000), history, rates: [] });
  assert.equal(report.measurements[0].anomaly.state, 'anomaly');
  assert.equal(report.measurements[0].anomaly.medianPerSecond, 1_000_000 / 86_400);
  const quiet = evaluateFinopsReport({ schemaVersion: 1, current: snapshot(10, 9_000_000), history, rates: [] });
  assert.equal(quiet.measurements[0].anomaly.state, 'within_candidate_baseline');
  const incomplete = evaluateFinopsReport({ schemaVersion: 1, current: snapshot(10, 18_000_000),
    history: history.slice(1), rates: [] });
  assert.equal(incomplete.measurements[0].anomaly.state, 'insufficient_baseline');
});

test('FinOps rejects reset counters, changed windows, altered quotas, ambiguous rates and secret dimensions', () => {
  for (const mutate of [
    (value) => { value.tenantId = 'private-tenant'; },
    (value) => { value.history[0].periodStart = '2026-10-02T00:00:00.000Z'; },
    (value) => { value.history[0].measurements[0].used = 96_000_000; },
    (value) => { value.history[0].measurements[0].limit = 90_000_000; },
    (value) => { value.history[0].observedAt = value.current.observedAt; },
    (value) => { value.rates.push(value.rates[0]); },
    (value) => { value.rates[0].source = 'application_egress'; },
    (value) => { value.rates[0].currency = '<script>'; },
    (value) => { value.rates[0].provenance = 'https://private-provider.invalid'; },
    (value) => { value.rates[0].unitSize = 0; },
    (value) => { value.rates[0].priceMicrosPerUnit = Number.MAX_SAFE_INTEGER; value.rates[0].unitSize = 1; },
    (value) => { value.rates[0].rateObservedAt = '2026-10-18T00:00:00.000Z'; },
    (value) => { value.rates[0].password = 'secret'; },
    (value) => { value.history = Array(33).fill(value.history[0]); },
  ]) {
    const value = input(); mutate(value);
    assert.throws(() => evaluateFinopsReport(value), /FINOPS_REPORT_/);
  }
});

test('offline dashboard contains semantic aggregate rows and rejects injected presentation fields', () => {
  const report = evaluateFinopsReport(input());
  const html = renderFinopsDashboard(report);
  assert.match(html, /scope="row">Database transfer/);
  assert.match(html, /Baseline incomplete/);
  assert.match(html, /USD 0\.001500/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script|tenantId|password|private-provider|https?:\/\//);
  assert.throws(() => renderFinopsDashboard({ ...report,
    measurements: [{ ...report.measurements[0], source: '<img onerror=alert(1)>' }] }), /FINOPS_DASHBOARD_INVALID/);
  assert.throws(() => renderFinopsDashboard({ ...report, observedAt: '<script>alert(1)</script>' }),
    /FINOPS_DASHBOARD_INVALID/);
});

test('FinOps CLI validates bounded files and exposes no invalid input or filename', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-finops-'));
  const filename = path.join(directory, 'private-operator.json');
  const run = (...extra) => spawnSync(process.execPath, ['scripts/finops-report.mjs', filename, ...extra],
    { encoding: 'utf8' });
  try {
    await writeFile(filename, JSON.stringify(input()));
    assert.equal(run().status, 0);
    assert.deepEqual(JSON.parse(run().stdout), evaluateFinopsReport(input()));
    assert.match(run('--html').stdout, /Transfer budget evidence/);
    for (const content of ['secret-invalid-json', ' '.repeat(65_537)]) {
      await writeFile(filename, content);
      assert.equal(run().status, 1);
      assert.equal(run().stdout, '');
      assert.equal(run().stderr, 'FINOPS_REPORT_FAILED\n');
    }
    assert.equal(run('--send').stderr, 'FINOPS_REPORT_FAILED\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
