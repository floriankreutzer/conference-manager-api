import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { compileProductDeliveryReport } from '../src/observability/product-delivery-report.js';

function source(counts) {
  let next = 0;
  return { schemaVersion: 1, environment: 'demo', observedAt: '2026-10-15T12:00:00.000Z',
    periodStart: '2026-09-17T00:00:00.000Z', periodEnd: '2026-10-15T00:00:00.000Z',
    productComplete: false, productEvents: [], deliveryComplete: { application: false, api: true, website: false },
    deployments: counts.map((count, index) => ({ source: 'render', sourceId: 'synthetic-' + index,
      component: 'api', artifactCommit: String(index + 1).padStart(40, '0'),
      changes: Array.from({ length: count }, () => ({ commit: (++next).toString(16).padStart(40, '0'),
        committedAt: '2026-09-18T00:00:00.000Z', firstSuccessfulDeployment: null })),
      deployedAt: '2026-09-19T00:00:00.000Z', outcome: 'unknown', failureAt: null, recoveredAt: null, rework: null })),
    feedbackSource: 'not_configured', feedbackComplete: false, feedback: [] };
}

test('a real-sized 194-change batch stays one deployment without invented lead time', () => {
  const input = source([194]);
  const report = compileProductDeliveryReport(input);
  const metrics = report.delivery[1].buckets[0].metrics;
  assert.equal(metrics.find(row => row.id === 'deployment_frequency').value, 1);
  for (const id of ['change_lead_time', 'change_failure_rate', 'failed_deployment_recovery_time', 'deployment_rework_rate']) {
    assert.equal(metrics.find(row => row.id === id).value, null);
    assert.equal(metrics.find(row => row.id === id).reason, 'missing_classification');
  }
  assert.equal(report.provenance.eventCount, 1);
  const result = spawnSync(process.execPath, ['scripts/compile-product-delivery.mjs'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, maxBuffer: 64000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), report);
});

test('the original 2000-change total remains enforced across one or several deployments', () => {
  for (const counts of [[2000], [1000, 1000]]) assert.doesNotThrow(() => compileProductDeliveryReport(source(counts)));
  for (const counts of [[2001], [1000, 1001]]) {
    assert.throws(() => compileProductDeliveryReport(source(counts)), /PRODUCT_DELIVERY_INVALID/);
  }
  const duplicate = source([194]);
  duplicate.deployments[0].changes[193] = { ...duplicate.deployments[0].changes[0] };
  assert.throws(() => compileProductDeliveryReport(duplicate), /PRODUCT_DELIVERY_INVALID/);
  const invalidClock = source([194]);
  invalidClock.deployments[0].changes[193].committedAt = '2026-09-20T00:00:00.000Z';
  assert.throws(() => compileProductDeliveryReport(invalidClock), /PRODUCT_DELIVERY_INVALID/);
});
