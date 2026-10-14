import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compileProductDeliveryReport,
  uncollectedProductDeliveryReport,
} from '../src/observability/product-delivery-report.js';
import { normalizeProductDeliverySnapshot } from '../src/observability/product-delivery-contract.js';

function source() {
  return {
    schemaVersion: 1,
    environment: 'demo',
    observedAt: '2026-10-15T12:00:00.000Z',
    periodStart: '2026-09-17T00:00:00.000Z',
    periodEnd: '2026-10-15T00:00:00.000Z',
    productComplete: true,
    productEvents: [],
    deliveryComplete: { application: true, api: true, website: false },
    deployments: [],
    feedbackSource: 'not_configured',
    feedbackComplete: false,
    feedback: [],
  };
}

function deployment(sourceId, overrides = {}) {
  return {
    source: 'render',
    sourceId,
    component: 'api',
    artifactCommit: 'a'.repeat(40),
    changes: [
      {
        commit: 'a'.repeat(40),
        committedAt: '2026-09-18T12:00:00.000Z',
        firstSuccessfulDeployment: true,
      },
    ],
    deployedAt: '2026-09-19T12:00:00.000Z',
    outcome: 'healthy',
    failureAt: null,
    recoveredAt: null,
    rework: false,
    ...overrides,
  };
}

function metric(report, id) {
  return report.product.find((item) => item.id === id);
}
function delivery(report, id) {
  return report.delivery[1].buckets[0].metrics.find((item) => item.id === id);
}

test('uncollected is unknown throughout; complete empty coverage permits counts but no ratios or durations', () => {
  const unknown = uncollectedProductDeliveryReport(Date.parse('2026-10-15T12:00:00.000Z'));
  assert.equal(unknown.observedAt, null);
  assert.equal(unknown.provenance.sourceDigest, null);
  assert.ok(unknown.product.every((item) => item.value === null));
  assert.ok(
    unknown.delivery.every((item) =>
      item.buckets.every((bucket) => bucket.metrics.every((m) => m.value === null)),
    ),
  );
  const empty = compileProductDeliveryReport(source());
  assert.equal(metric(empty, 'request_submitted').value, 0);
  assert.equal(metric(empty, 'request_started').value, null);
  assert.equal(metric(empty, 'time_to_submit').reason, 'missing_start_clock');
  assert.equal(delivery(empty, 'deployment_frequency').value, 0);
  assert.equal(delivery(empty, 'change_failure_rate').value, null);
  assert.equal(delivery(empty, 'change_failure_rate').reason, 'empty_denominator');
  assert.equal(empty.feedback.total, null);
});

test('five service-specific measures use real deployment/change classifications and retain unresolved recovery', () => {
  const input = source();
  input.deployments = [
    deployment('dep-1'),
    deployment('dep-2', {
      changes: [
        {
          commit: 'a'.repeat(40),
          committedAt: '2026-09-18T12:00:00.000Z',
          firstSuccessfulDeployment: false,
        },
      ],
      deployedAt: '2026-09-20T12:00:00.000Z',
      rework: true,
    }),
    deployment('dep-3', {
      artifactCommit: 'b'.repeat(40),
      changes: [],
      outcome: 'impaired',
      failureAt: '2026-09-19T12:30:00.000Z',
      recoveredAt: '2026-09-19T13:30:00.000Z',
    }),
  ];
  const report = compileProductDeliveryReport(input);
  assert.equal(delivery(report, 'change_lead_time').value, 86_400_000);
  assert.equal(delivery(report, 'deployment_frequency').value, 3);
  assert.equal(delivery(report, 'failed_deployment_recovery_time').value, 3_600_000);
  assert.equal(delivery(report, 'change_failure_rate').value, 1 / 3);
  assert.equal(delivery(report, 'deployment_rework_rate').value, 1 / 3);
  assert.equal(report.delivery[1].buckets[0].unresolvedRecoveries, 0);
  input.deployments[2].recoveredAt = null;
  assert.equal(compileProductDeliveryReport(input).delivery[1].buckets[0].unresolvedRecoveries, 1);
  assert.equal(
    delivery(compileProductDeliveryReport(input), 'failed_deployment_recovery_time').reason,
    'unresolved_recovery',
  );
  input.deployments[0].changes[0].firstSuccessfulDeployment = null;
  assert.equal(
    delivery(compileProductDeliveryReport(input), 'change_lead_time').reason,
    'missing_classification',
  );
  input.deployments[1].rework = null;
  assert.equal(delivery(compileProductDeliveryReport(input), 'deployment_rework_rate').value, null);
  assert.ok(
    report.delivery[2].buckets.every((bucket) =>
      bucket.metrics.every((item) => item.value === null),
    ),
  );
});

test('outcomes and structured feedback aggregate without emitting identities, content or customer labels', () => {
  const input = source();
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const targetId = 'request-source-1';
  input.productEvents = [
    {
      source: 'tenant_audit',
      sourceId: 'audit-1',
      kind: 'request_submitted',
      occurredAt: '2026-09-20T12:00:00.000Z',
      tenantId,
      targetId,
    },
    {
      source: 'request_revision',
      sourceId: 'revision-2',
      kind: 'manager_decision',
      occurredAt: '2026-09-20T13:00:00.000Z',
      tenantId,
      targetId,
    },
  ];
  input.feedbackSource = 'protected_operator_registry';
  input.feedbackComplete = true;
  input.feedback = [
    {
      source: 'protected_operator_registry',
      sourceId: 'case-1',
      occurredAt: '2026-09-20T12:00:00.000Z',
      category: 'usability',
      workflow: 'request',
      severity: 'high',
      sentiment: 'negative',
      state: 'open',
    },
  ];
  const report = compileProductDeliveryReport(input);
  assert.equal(metric(report, 'request_submitted').value, 1);
  assert.equal(metric(report, 'manager_decisions').value, 1);
  assert.equal(metric(report, 'manager_decision_time').value, 3_600_000);
  assert.equal(report.feedback.total, 1);
  assert.equal(report.feedback.open, 1);
  assert.equal(report.feedback.highSeverity, 1);
  assert.equal(report.feedback.sentiments.find((group) => group.id === 'negative').count, 1);
  assert.equal(report.feedback.categories.find((group) => group.id === 'usability').count, 1);
  const bytes = JSON.stringify(report);
  for (const value of [tenantId, targetId, 'audit-1', 'revision-2', 'case-1'])
    assert.ok(!bytes.includes(value));
  input.productComplete = false;
  assert.ok(compileProductDeliveryReport(input).product.every((item) => item.value === null));
});

test('rejects duplicate identities, unknown fields/sources, bad clocks, raw feedback and contradictory first deployments', () => {
  const mutations = [
    (v) => {
      v.productEvents = [
        {
          source: 'browser',
          sourceId: '1',
          kind: 'request_submitted',
          occurredAt: v.periodStart,
          tenantId: '10000000-0000-4000-8000-000000000001',
          targetId: 'request-1',
        },
      ];
    },
    (v) => {
      v.deployments = [deployment('same'), deployment('same')];
    },
    (v) => {
      v.deployments = [deployment('first'), deployment('second')];
    },
    (v) => {
      v.deployments = [
        deployment('old', {
          changes: [
            {
              commit: 'a'.repeat(40),
              committedAt: '2026-09-18T12:00:00.000Z',
              firstSuccessfulDeployment: false,
            },
          ],
        }),
        deployment('late-first', { deployedAt: '2026-09-20T12:00:00.000Z' }),
      ];
    },
    (v) => {
      v.deployments = [
        deployment('time-1'),
        deployment('time-2', {
          changes: [
            {
              commit: 'a'.repeat(40),
              committedAt: '2026-09-18T13:00:00.000Z',
              firstSuccessfulDeployment: false,
            },
          ],
        }),
      ];
    },
    (v) => {
      v.deployments = [deployment('1', { recoveredAt: v.observedAt })];
    },
    (v) => {
      v.deployments = [deployment('1', { outcome: 'impaired', failureAt: v.periodStart })];
    },
    (v) => {
      v.productEvents = [
        {
          source: 'tenant_audit',
          sourceId: '1',
          kind: 'manager_decision',
          occurredAt: v.periodStart,
          tenantId: '10000000-0000-4000-8000-000000000001',
          targetId: 'request-1',
        },
      ];
    },
    (v) => {
      v.feedback = [{ freeText: 'customer material' }];
    },
    (v) => {
      v.periodEnd = v.periodStart;
    },
    (v) => {
      v.ownerEmail = 'private@example.invalid';
    },
  ];
  for (const mutate of mutations) {
    const value = source();
    mutate(value);
    assert.throws(() => compileProductDeliveryReport(value));
  }
  const report = compileProductDeliveryReport(source());
  assert.throws(() => normalizeProductDeliverySnapshot({ ...report, tenantId: 'foreign' }));
  const forged = JSON.parse(JSON.stringify(report));
  forged.product[0].value = 0;
  forged.product[0].reason = 'incomplete_source';
  assert.throws(() => normalizeProductDeliverySnapshot(forged));
});

test('actual compiler emits only bounded aggregate JSON and fails closed without logging source data', () => {
  const script = fileURLToPath(new URL('../scripts/compile-product-delivery.mjs', import.meta.url));
  const run = (input) =>
    spawnSync(process.execPath, [script], {
      input,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64_000,
    });
  const good = run(JSON.stringify(source()));
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), compileProductDeliveryReport(source()));
  for (const input of ['x'.repeat(256_001), JSON.stringify({ password: 'must-never-be-logged' })]) {
    const bad = run(input);
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, '');
    assert.equal(bad.stderr, 'PRODUCT_DELIVERY_COMPILATION_FAILED\n');
  }
});

test('server-derived request correlation never joins equal request IDs from different tenants', () => {
  const input = source();
  input.productEvents = [
    {
      source: 'tenant_audit',
      sourceId: '1',
      kind: 'request_submitted',
      occurredAt: '2026-09-20T12:00:00.000Z',
      tenantId: '10000000-0000-4000-8000-000000000001',
      targetId: 'collision',
    },
    {
      source: 'request_revision',
      sourceId: '2',
      kind: 'manager_decision',
      occurredAt: '2026-09-20T13:00:00.000Z',
      tenantId: '10000000-0000-4000-8000-000000000002',
      targetId: 'collision',
    },
  ];
  assert.equal(metric(compileProductDeliveryReport(input), 'manager_decision_time').value, null);
  input.productEvents[1].tenantId = input.productEvents[0].tenantId;
  assert.equal(
    metric(compileProductDeliveryReport(input), 'manager_decision_time').value,
    3_600_000,
  );
});

test('unknown deployment outcome prevents failure and recovery claims without hiding a recorded deployment', () => {
  const input = source();
  input.deployments = [
    deployment('known', {
      outcome: 'impaired',
      changes: [],
      failureAt: '2026-09-19T12:00:00.000Z',
      recoveredAt: '2026-09-19T13:00:00.000Z',
    }),
    deployment('unknown', { outcome: 'unknown', changes: [] }),
  ];
  const report = compileProductDeliveryReport(input);
  assert.equal(delivery(report, 'deployment_frequency').value, 2);
  assert.equal(delivery(report, 'change_failure_rate').value, null);
  assert.equal(delivery(report, 'failed_deployment_recovery_time').value, null);
  assert.equal(delivery(report, 'change_lead_time').value, null);
});

test('equal deployment timestamps do not make aggregate results depend on input order', () => {
  const input = source();
  input.deployments = [
    deployment('first'),
    deployment('repeat', {
      changes: [
        {
          commit: 'a'.repeat(40),
          committedAt: '2026-09-18T12:00:00.000Z',
          firstSuccessfulDeployment: false,
        },
      ],
    }),
  ];
  const forward = compileProductDeliveryReport(input);
  input.deployments.reverse();
  const reverse = compileProductDeliveryReport(input);
  assert.deepEqual(reverse.delivery, forward.delivery);
});

test('snapshot validation rejects metric-incompatible reasons and contradictory recovery coverage', () => {
  const mutations = [
    (v) => {
      v.product[0].reason = 'empty_denominator';
    },
    (v) => {
      v.delivery[0].buckets[0].metrics[1].reason = 'missing_start_clock';
    },
    (v) => {
      v.delivery[0].buckets[0].metrics[2].reason = 'unresolved_recovery';
    },
    (v) => {
      v.delivery[0].buckets[0].unresolvedRecoveries = 0;
    },
  ];
  for (const mutate of mutations) {
    const value = uncollectedProductDeliveryReport(Date.parse('2026-10-15T12:00:00.000Z'));
    const copy = JSON.parse(JSON.stringify(value));
    mutate(copy);
    assert.throws(() => normalizeProductDeliverySnapshot(copy));
  }
  const complete = compileProductDeliveryReport(source());
  const bad = JSON.parse(JSON.stringify(complete));
  bad.delivery[0].buckets[0].metrics[2].reason = 'unresolved_recovery';
  assert.throws(() => normalizeProductDeliverySnapshot(bad));
  const nonempty = source();
  nonempty.deployments = [deployment('known-healthy')];
  const invalid = compileProductDeliveryReport(nonempty);
  const altered = JSON.parse(JSON.stringify(invalid));
  altered.delivery[1].buckets[0].metrics[2].reason = 'unresolved_recovery';
  assert.throws(() => normalizeProductDeliverySnapshot(altered));
});

test('decision duration requires a positive known decision and submission cohort', () => {
  for (const base of [
    compileProductDeliveryReport(source()),
    uncollectedProductDeliveryReport(Date.parse('2026-10-15T12:00:00.000Z')),
  ]) {
    const invalid = JSON.parse(JSON.stringify(base));
    const duration = invalid.product.find((item) => item.id === 'manager_decision_time');
    duration.value = 500;
    duration.reason = 'available';
    assert.throws(() => normalizeProductDeliverySnapshot(invalid));
  }
  const partial = JSON.parse(JSON.stringify(compileProductDeliveryReport(source())));
  partial.product.find((item) => item.id === 'manager_decisions').value = null;
  partial.product.find((item) => item.id === 'manager_decisions').reason = 'incomplete_source';
  assert.throws(() => normalizeProductDeliverySnapshot(partial));
});

test('closed snapshots retain source-record ceilings and possible time bounds', () => {
  const input = source();
  input.deployments = [deployment('bounded-deploy')];
  for (const mutate of [
    (v) => {
      v.delivery[1].buckets[0].metrics[0].value = Number.MAX_SAFE_INTEGER;
    },
    (v) => {
      v.product[0].value = 2000;
      v.product[1].value = 1;
      v.provenance.eventCount = 4200;
    },
    (v) => {
      v.delivery[1].buckets[0].metrics[1].value = 2000;
      v.delivery[1].buckets[1].metrics[1].value = 1;
      for (const index of [1, 3, 4]) {
        v.delivery[1].buckets[1].metrics[index].value = index === 1 ? 1 : 0;
        v.delivery[1].buckets[1].metrics[index].reason = 'available';
      }
      v.provenance.eventCount = 4200;
    },
  ]) {
    const report = JSON.parse(JSON.stringify(compileProductDeliveryReport(input)));
    mutate(report);
    assert.throws(() => normalizeProductDeliverySnapshot(report));
  }
});

test('decision clocks pair one-to-one and never reuse an older superseded submission', () => {
  const input = JSON.parse(
    readFileSync(
      new URL('./support/product-delivery-source-fixture.json', import.meta.url),
      'utf8',
    ),
  );
  const second = {
    ...input.productEvents[1],
    sourceId: 'second-decision',
    occurredAt: '2026-10-14T14:00:00.000Z',
  };
  input.productEvents.push(second);
  assert.equal(metric(compileProductDeliveryReport(input), 'manager_decision_time').value, null);
  input.productEvents.push({
    ...input.productEvents[0],
    sourceId: 'resubmission',
    occurredAt: '2026-10-14T12:00:00.000Z',
  });
  assert.equal(
    metric(compileProductDeliveryReport(input), 'manager_decision_time').value,
    5_400_000,
  );
  input.productEvents[3].occurredAt = '2026-10-14T10:30:00.000Z';
  assert.equal(metric(compileProductDeliveryReport(input), 'manager_decision_time').value, null);
  input.productEvents.reverse();
  assert.equal(metric(compileProductDeliveryReport(input), 'manager_decision_time').value, null);
  const corrupt = JSON.parse(JSON.stringify(compileProductDeliveryReport(source())));
  corrupt.product.find((item) => item.id === 'manager_decisions').value = 2;
  corrupt.product.find((item) => item.id === 'request_submitted').value = 1;
  const duration = corrupt.product.find((item) => item.id === 'manager_decision_time');
  duration.value = 500;
  duration.reason = 'available';
  corrupt.provenance.eventCount = 3;
  assert.throws(() => normalizeProductDeliverySnapshot(corrupt));
});

test('recovery ceilings start at the originating weekly deployment bucket', () => {
  const input = JSON.parse(
    readFileSync(
      new URL('./support/product-delivery-source-fixture.json', import.meta.url),
      'utf8',
    ),
  );
  Object.assign(input.deployments[0], {
    outcome: 'impaired',
    failureAt: input.deployments[0].deployedAt,
    recoveredAt: '2026-10-15T10:00:00.000Z',
    changes: [],
  });
  const report = compileProductDeliveryReport(input);
  const recovery = report.delivery[1].buckets[3].metrics[2];
  assert.equal(recovery.value, 79_199_500);
  const corrupt = JSON.parse(JSON.stringify(report));
  corrupt.delivery[1].buckets[3].metrics[2].value = 20 * 86_400_000;
  assert.throws(() => normalizeProductDeliverySnapshot(corrupt));
});
