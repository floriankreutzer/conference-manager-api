import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateTransferBudget } from '../src/observability/transfer-budget.js';

function input(used = 50, limit = 100) {
  return {
    schemaVersion: 1,
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    observedAt: '2026-10-16T12:00:00.000Z',
    measurements: [{ source: 'database_transfer', unit: 'bytes', used, limit }],
  };
}

test('provider totals yield exact threshold boundaries and a separately identified forecast', () => {
  for (const used of [0, 49, 50, 69, 70, 84, 85, 94, 95, 99, 100, 101]) {
    const report = evaluateTransferBudget(input(used));
    const measurement = report.measurements[0];
    assert.equal(measurement.utilizationPercent, used);
    assert.deepEqual(measurement.crossedThresholds, [50, 70, 85, 95].filter((value) => used >= value));
    assert.equal(measurement.exhausted, used >= 100);
    assert.equal(measurement.projected, used * 2);
    assert.equal(measurement.projectedExhaustion, used >= 50);
    assert.equal(report.forecastMethod, 'linear_elapsed_window');
    assert.ok(Object.isFrozen(report));
    assert.ok(Object.isFrozen(measurement.crossedThresholds));
  }
});

test('billing windows and measurement units stay independent without double counting', () => {
  const value = input();
  value.observedAt = value.periodEnd;
  value.measurements.push({ source: 'ci_runtime', unit: 'seconds', used: 360, limit: 600 });
  const report = evaluateTransferBudget(value);
  assert.equal(report.measurements.length, 2);
  assert.equal(report.measurements[0].source, 'ci_runtime');
  assert.equal(report.measurements[1].projected, 50);
  assert.equal(report.total, undefined);
});

test('budget schemas reject untrusted dimensions, malformed totals and duplicate sources', () => {
  const cases = [
    { ...input(), account: 'secret-account' },
    { ...input(), schemaVersion: 2 },
    { ...input(), observedAt: '2026-02-30T00:00:00.000Z' },
    { ...input(), observedAt: input().periodStart },
    { ...input(), observedAt: '2026-11-02T00:00:00.000Z' },
    { ...input(), periodEnd: '2027-11-01T00:00:00.000Z' },
    { ...input(), measurements: [] },
    { ...input(), measurements: Array(5).fill(input().measurements[0]) },
    { ...input(), measurements: Array(2).fill(input().measurements[0]) },
  ];
  for (const value of cases) assert.throws(() => evaluateTransferBudget(value), /TRANSFER_BUDGET_/);
  for (const patch of [
    { used: -1 }, { used: 1.5 }, { used: '50' }, { used: Infinity }, { used: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { source: '__proto__' }, { source: ['database_transfer'] },
    { unit: 'GB' }, { tenantId: 'secret-tenant' }, { source: 'https://example.invalid' },
  ]) {
    const value = input();
    value.measurements[0] = { ...value.measurements[0], ...patch };
    assert.throws(() => evaluateTransferBudget(value), /TRANSFER_BUDGET_/);
  }
});

test('projection overflow is rejected rather than silently rounded or clamped', () => {
  const value = input(Number.MAX_SAFE_INTEGER);
  value.observedAt = '2026-10-01T00:00:00.001Z';
  assert.throws(() => evaluateTransferBudget(value), /TRANSFER_BUDGET_PROJECTION_OVERFLOW/);
});

test('budget CLI emits only validated totals and conceals invalid file contents and paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-transfer-budget-'));
  const filename = path.join(directory, 'secret-account.json');
  const run = () => spawnSync(process.execPath, ['scripts/transfer-budget.mjs', filename], { encoding: 'utf8' });
  try {
    await writeFile(filename, JSON.stringify(input()));
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout), evaluateTransferBudget(input()));
    for (const content of ['secret-password-not-json', ' '.repeat(16_385), JSON.stringify({ ...input(), token: 'secret' })]) {
      await writeFile(filename, content);
      const failure = run();
      assert.equal(failure.status, 1);
      assert.equal(failure.stdout, '');
      assert.equal(failure.stderr, 'TRANSFER_BUDGET_REPORT_FAILED\n');
    }
    await rm(filename);
    assert.equal(run().stderr, 'TRANSFER_BUDGET_REPORT_FAILED\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
