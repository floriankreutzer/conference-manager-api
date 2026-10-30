import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectProtectedInsightReadiness } from '../scripts/support/protected-insight-readiness.mjs';
const now=Date.parse('2026-10-30T12:00:00.000Z');
const providerSnapshot=JSON.stringify({ schemaVersion: 1,plan: 'launch_v3',referenceObservedAt: '2026-10-01T00:00:00.000Z',
  finops: { schemaVersion: 1,current: { schemaVersion: 1,periodStart: '2026-10-01T00:00:00.000Z',periodEnd: '2026-11-01T00:00:00.000Z',
    observedAt: '2026-10-30T11:00:00.000Z',measurements: [
      { source: 'database_transfer',unit: 'bytes',used: 7654321,limit: 500000000000 }] },history: [],rates: [] } });

test('missing protected inputs remain explicit incomplete sources without replacing measurements with zero',()=>{
  const report=inspectProtectedInsightReadiness({ now });
  assert.equal(report.state,'incomplete');
  assert.equal(report.product.availableMetrics,0);assert.equal(report.product.totalMetrics,12);
  assert.equal(report.product.missing.length,12);
  assert.equal(report.providers.configured,false);assert.equal(report.feedback.available,false);
  assert.equal(report.metering.state,'not_verified');
  assert.ok(report.blockers.includes('product_source_incomplete'));
});

test('fresh Neon evidence cannot certify other vendors, billing or Tenant metering; source values never leave inspection',()=>{
  const report=inspectProtectedInsightReadiness({ now,providerSnapshot });
  assert.equal(report.providers.freshness,'fresh');assert.equal(report.providers.neonMeasurementAvailable,true);
  assert.equal(report.providers.accountBillingVerified,false);
  for (const code of ['render_source_not_connected','github_source_not_connected','resend_source_not_connected','metering_not_verified']) {
    assert.ok(report.blockers.includes(code));
  }
  assert.doesNotMatch(JSON.stringify(report),/7654321|500000000000|launch_v3/);
  const stale=inspectProtectedInsightReadiness({ now: now+86400000,providerSnapshot });
  assert.equal(stale.providers.freshness,'stale');assert.ok(stale.blockers.includes('provider_snapshot_not_fresh'));
});

test('the operator CLI differentiates unavailable collection from invalid input without echoing private configuration',()=>{
  const run=(env={},args=[])=>spawnSync(process.execPath,['scripts/check-protected-insight-readiness.mjs',...args],{
    env: { PATH: process.env.PATH,...env },encoding: 'utf8',timeout: 10000 });
  const missing=run();assert.equal(missing.status,2);assert.equal(JSON.parse(missing.stdout).state,'incomplete');
  for (const result of [run({ PROTECTED_PLATFORM_PRODUCT_DELIVERY_SNAPSHOT: 'private-canary' }),run({},['foreign.json'])]) {
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'PROTECTED_INSIGHT_READINESS_INVALID\n');
  }
});
