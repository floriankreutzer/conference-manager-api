import { createHash } from 'node:crypto';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  DAY_MS,
  DELIVERY_COMPONENTS,
  DELIVERY_METRIC_IDS,
  PRODUCT_METRIC_IDS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_WORKFLOWS,
  FEEDBACK_SENTIMENTS,
  exactProductObject as exact,
  normalizeProductDeliverySnapshot,
  productInstant as instant,
  productMetric as metric,
  requireProductCondition as requireCondition,
} from './product-delivery-contract.js';

const MAX_DELIVERY_CHANGES = 2000;

const PRODUCT_SOURCES = Object.freeze({
  onboarding_started: 'platform_audit',
  onboarding_completed: 'platform_audit',
  request_submitted: 'tenant_audit',
  manager_decision: 'request_revision',
  transition_failure: 'tenant_audit',
  recovery_completed: 'platform_audit',
  recovery_failed: 'platform_audit',
});

function requestWorkflowKey(event) {
  return createHash('sha256')
    .update(JSON.stringify([event.tenantId.toLowerCase(), event.targetId]))
    .digest('hex');
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sourceId(value) {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value));
}

function uniqueIdentities(events) {
  const identities = events.map((event) =>
    createHash('sha256')
      .update(JSON.stringify([event.source, event.sourceId]))
      .digest('hex'),
  );
  requireCondition(new Set(identities).size === identities.length);
}

function validateInput(input) {
  exact(input, [
    'schemaVersion',
    'environment',
    'observedAt',
    'periodStart',
    'periodEnd',
    'productComplete',
    'productEvents',
    'deliveryComplete',
    'deployments',
    'feedbackSource',
    'feedbackComplete',
    'feedback',
  ]);
  requireCondition(input.schemaVersion === 1 && ['demo', 'production'].includes(input.environment));
  const start = instant(input.periodStart);
  const end = instant(input.periodEnd);
  const observed = instant(input.observedAt);
  requireCondition(
    end - start === 28 * DAY_MS &&
      start % DAY_MS === 0 &&
      observed >= end &&
      observed - end < DAY_MS &&
      typeof input.productComplete === 'boolean' &&
      typeof input.feedbackComplete === 'boolean',
  );
  exact(input.deliveryComplete, DELIVERY_COMPONENTS);
  requireCondition(
    DELIVERY_COMPONENTS.every((id) => typeof input.deliveryComplete[id] === 'boolean'),
  );
  for (const [events, limit] of [
    [input.productEvents, 2000],
    [input.deployments, 2000],
    [input.feedback, 200],
  ]) {
    requireCondition(Array.isArray(events) && events.length <= limit);
  }
  requireCondition(
    input.deployments.reduce(
      (sum, event) => sum + (Array.isArray(event?.changes) ? event.changes.length : 0),
      0,
    ) <= MAX_DELIVERY_CHANGES,
  );
  input.productEvents.forEach((event) => {
    exact(event, ['source', 'sourceId', 'kind', 'occurredAt', 'tenantId', 'targetId']);
    sourceId(event.sourceId);
    requireCondition(
      Object.hasOwn(PRODUCT_SOURCES, event.kind) &&
        event.source === PRODUCT_SOURCES[event.kind] &&
        isInternalUuid(event.tenantId) &&
        typeof event.targetId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.targetId) &&
        instant(event.occurredAt) >= start &&
        instant(event.occurredAt) < end,
    );
  });
  uniqueIdentities(input.productEvents);
  input.deployments.forEach((event) => {
    exact(event, [
      'source',
      'sourceId',
      'component',
      'artifactCommit',
      'changes',
      'deployedAt',
      'outcome',
      'failureAt',
      'recoveredAt',
      'rework',
    ]);
    sourceId(event.sourceId);
    requireCondition(
      ['render', 'github_pages'].includes(event.source) &&
        DELIVERY_COMPONENTS.includes(event.component) &&
        typeof event.artifactCommit === 'string' &&
        /^[a-f0-9]{40}$/.test(event.artifactCommit) &&
        Array.isArray(event.changes) &&
        event.changes.length <= MAX_DELIVERY_CHANGES &&
        instant(event.deployedAt) >= start &&
        instant(event.deployedAt) < end &&
        ['healthy', 'impaired', 'unknown'].includes(event.outcome) &&
        (event.rework === null || typeof event.rework === 'boolean'),
    );
    event.changes.forEach((change) => {
      exact(change, ['commit', 'committedAt', 'firstSuccessfulDeployment']);
      requireCondition(
        typeof change.commit === 'string' &&
          /^[a-f0-9]{40}$/.test(change.commit) &&
          instant(change.committedAt) <= instant(event.deployedAt) &&
          (change.firstSuccessfulDeployment === null ||
            typeof change.firstSuccessfulDeployment === 'boolean'),
      );
    });
    requireCondition(
      new Set(event.changes.map((change) => change.commit)).size === event.changes.length,
    );
    requireCondition(
      event.outcome === 'healthy' ||
        event.changes.every((change) => change.firstSuccessfulDeployment !== true),
    );
    if (event.outcome === 'impaired') {
      requireCondition(
        instant(event.failureAt) >= instant(event.deployedAt) &&
          instant(event.failureAt) <= observed,
      );
      if (event.recoveredAt !== null)
        requireCondition(
          instant(event.recoveredAt) >= instant(event.failureAt) &&
            instant(event.recoveredAt) <= observed,
        );
    } else requireCondition(event.failureAt === null && event.recoveredAt === null);
  });
  uniqueIdentities(input.deployments);
  for (const component of DELIVERY_COMPONENTS) {
    const commits = new Map();
    const events = input.deployments
      .filter((event) => event.component === component)
      .sort((left, right) => left.deployedAt.localeCompare(right.deployedAt));
    for (const event of events) {
      for (const change of event.changes) {
        const previous = commits.get(change.commit);
        requireCondition(!previous || previous.committedAt === change.committedAt);
        if (event.outcome === 'healthy' && change.firstSuccessfulDeployment === true) {
          requireCondition(
            !previous?.firstReported &&
              (!previous?.healthyAt || previous.healthyAt === event.deployedAt),
          );
        }
        commits.set(change.commit, {
          committedAt: change.committedAt,
          firstReported:
            previous?.firstReported === true ||
            (event.outcome === 'healthy' && change.firstSuccessfulDeployment === true),
          healthyAt: previous?.healthyAt || (event.outcome === 'healthy' ? event.deployedAt : null),
        });
      }
    }
  }

  requireCondition(
    ['not_configured', 'protected_operator_registry'].includes(input.feedbackSource),
  );
  if (input.feedbackSource === 'not_configured')
    requireCondition(!input.feedbackComplete && input.feedback.length === 0);
  input.feedback.forEach((event) => {
    exact(event, [
      'source',
      'sourceId',
      'occurredAt',
      'category',
      'workflow',
      'severity',
      'sentiment',
      'state',
    ]);
    sourceId(event.sourceId);
    requireCondition(
      event.source === 'protected_operator_registry' &&
        instant(event.occurredAt) >= start &&
        instant(event.occurredAt) < end &&
        FEEDBACK_CATEGORIES.includes(event.category) &&
        FEEDBACK_WORKFLOWS.includes(event.workflow) &&
        ['low', 'medium', 'high'].includes(event.severity) &&
        FEEDBACK_SENTIMENTS.includes(event.sentiment) &&
        ['open', 'reviewed', 'resolved'].includes(event.state),
    );
  });
  uniqueIdentities(input.feedback);
  return { start, end };
}

function productMetrics(input) {
  const count = (kind) =>
    input.productComplete
      ? input.productEvents.filter((event) => event.kind === kind).length
      : null;
  const submissionsByWorkflow = new Map();
  for (const event of input.productEvents.filter((item) => item.kind === 'request_submitted')) {
    const key = requestWorkflowKey(event);
    const submissions = submissionsByWorkflow.get(key) || [];
    submissions.push(event);
    submissionsByWorkflow.set(key, submissions);
  }
  const order = (left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.sourceId.localeCompare(right.sourceId);
  for (const submissions of submissionsByWorkflow.values()) submissions.sort(order);
  const decisions = input.productEvents
    .filter((event) => event.kind === 'manager_decision')
    .sort(order);
  const consumed = new Set();
  const durations = decisions.map((event) => {
    const latest = submissionsByWorkflow
      .get(requestWorkflowKey(event))
      ?.findLast((candidate) => candidate.occurredAt <= event.occurredAt);
    // A later resubmission supersedes the earlier pending clock. Never reuse one
    // submission for two decisions or fall back to an older superseded clock.
    if (!latest || consumed.has(latest)) return null;
    consumed.add(latest);
    return instant(event.occurredAt) - instant(latest.occurredAt);
  });
  const duration =
    input.productComplete && durations.every((value) => value !== null) ? median(durations) : null;
  const recoveryCompleted = count('recovery_completed');
  const recoveryFailed = count('recovery_failed');
  const recoveryTotal = (recoveryCompleted || 0) + (recoveryFailed || 0);
  const values = [
    count('onboarding_started'),
    count('onboarding_completed'),
    null,
    count('request_submitted'),
    null,
    null,
    count('manager_decision'),
    duration,
    count('transition_failure'),
    recoveryCompleted,
    recoveryFailed,
    input.productComplete && recoveryTotal > 0 ? recoveryFailed / recoveryTotal : null,
  ];
  return PRODUCT_METRIC_IDS.map((id, index) =>
    metric(
      id,
      values[index],
      ['request_started', 'request_abandoned', 'time_to_submit'].includes(id)
        ? 'missing_start_clock'
        : id === 'recovery_failure_rate' && input.productComplete
          ? 'empty_denominator'
          : 'incomplete_source',
    ),
  );
}

function deliveryBucket(events, complete) {
  if (!complete) return DELIVERY_METRIC_IDS.map((id) => metric(id));
  const healthy = events.filter((event) => event.outcome === 'healthy');
  const failed = events.filter((event) => event.outcome === 'impaired');
  const classified = events.every((event) => event.outcome !== 'unknown');
  const leadKnown =
    classified &&
    healthy.every((event) =>
      event.changes.every((change) => change.firstSuccessfulDeployment !== null),
    );
  const leadTimes = healthy.flatMap((event) =>
    event.changes
      .filter((change) => change.firstSuccessfulDeployment)
      .map((change) => instant(event.deployedAt) - instant(change.committedAt)),
  );
  const recovery =
    failed.length && failed.every((event) => event.recoveredAt !== null)
      ? median(failed.map((event) => instant(event.recoveredAt) - instant(event.failureAt)))
      : null;
  return [
    metric(
      'change_lead_time',
      leadKnown ? median(leadTimes) : null,
      leadKnown ? 'empty_denominator' : 'missing_classification',
    ),
    metric('deployment_frequency', events.length),
    metric(
      'failed_deployment_recovery_time',
      classified ? recovery : null,
      !classified
        ? 'missing_classification'
        : failed.some((event) => event.recoveredAt === null)
          ? 'unresolved_recovery'
          : 'empty_denominator',
    ),
    metric(
      'change_failure_rate',
      events.length && classified ? failed.length / events.length : null,
      events.length ? 'missing_classification' : 'empty_denominator',
    ),
    metric(
      'deployment_rework_rate',
      events.length && events.every((event) => event.rework !== null)
        ? events.filter((event) => event.rework).length / events.length
        : null,
      events.length ? 'missing_classification' : 'empty_denominator',
    ),
  ];
}

function deliveryMetrics(input, start) {
  return DELIVERY_COMPONENTS.map((component) => {
    const events = input.deployments
      .filter((event) => event.component === component)
      .sort((left, right) => left.deployedAt.localeCompare(right.deployedAt));
    return {
      component,
      buckets: Array.from({ length: 4 }, (_, index) => {
        const from = start + index * 7 * DAY_MS;
        const until = from + 7 * DAY_MS;
        const selected = events.filter(
          (event) => instant(event.deployedAt) >= from && instant(event.deployedAt) < until,
        );
        return {
          periodStart: new Date(from).toISOString(),
          periodEnd: new Date(until).toISOString(),
          metrics: deliveryBucket(selected, input.deliveryComplete[component]),
          unresolvedRecoveries:
            input.deliveryComplete[component] &&
            selected.every((event) => event.outcome !== 'unknown')
              ? selected.filter(
                  (event) => event.outcome === 'impaired' && event.recoveredAt === null,
                ).length
              : null,
        };
      }),
    };
  });
}

export function compileProductDeliveryReport(input) {
  const { start } = validateInput(input);
  const feedbackKnown = input.feedbackSource !== 'not_configured' && input.feedbackComplete;
  return normalizeProductDeliverySnapshot({
    schemaVersion: 1,
    environment: input.environment,
    observedAt: input.observedAt,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    product: productMetrics(input),
    feedback: {
      source: input.feedbackSource,
      total: feedbackKnown ? input.feedback.length : null,
      open: feedbackKnown ? input.feedback.filter((event) => event.state === 'open').length : null,
      highSeverity: feedbackKnown
        ? input.feedback.filter((event) => event.severity === 'high').length
        : null,
      categories: FEEDBACK_CATEGORIES.map((id) => ({
        id,
        count: feedbackKnown
          ? input.feedback.filter((event) => event.category === id).length
          : null,
      })),
      workflows: FEEDBACK_WORKFLOWS.map((id) => ({
        id,
        count: feedbackKnown
          ? input.feedback.filter((event) => event.workflow === id).length
          : null,
      })),
      sentiments: FEEDBACK_SENTIMENTS.map((id) => ({
        id,
        count: feedbackKnown
          ? input.feedback.filter((event) => event.sentiment === id).length
          : null,
      })),
    },
    delivery: deliveryMetrics(input, start),
    provenance: {
      mode: 'operator_extract',
      sourceDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      eventCount: input.productEvents.length + input.deployments.length + input.feedback.length,
    },
  });
}

export function uncollectedProductDeliveryReport(now = Date.now()) {
  requireCondition(Number.isSafeInteger(now) && now >= 28 * DAY_MS);
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const report = compileProductDeliveryReport({
    schemaVersion: 1,
    environment: 'demo',
    periodStart: new Date(end - 28 * DAY_MS).toISOString(),
    periodEnd: new Date(end).toISOString(),
    observedAt: new Date(now).toISOString(),
    productComplete: false,
    productEvents: [],
    deliveryComplete: { application: false, api: false, website: false },
    deployments: [],
    feedbackSource: 'not_configured',
    feedbackComplete: false,
    feedback: [],
  });
  return normalizeProductDeliverySnapshot({
    ...report,
    observedAt: null,
    provenance: { mode: 'not_collected', sourceDigest: null, eventCount: 0 },
  });
}
