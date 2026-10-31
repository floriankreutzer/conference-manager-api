import { createHash } from 'node:crypto';
import { AUDIT_ACTION } from '../audit/event.js';
import { DAY_MS, PRODUCT_METRIC_IDS, productMetric, productInstant } from './product-delivery-contract.js';
import { normalizeRuntimeProductReport, PRODUCT_RUNTIME_MAX_EVENTS } from './product-runtime-contract.js';

const DECISIONS = new Set(['Confirmed', 'Rejected', 'Change Requested']);
const TENANT_METRICS = new Set(['onboarding_started', 'request_started', 'request_submitted',
  'request_abandoned', 'time_to_submit', 'manager_decisions', 'manager_decision_time', 'transition_failures']);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workflowKey = (event) => hash([event.tenantId, event.targetId]);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tenantFacts(events, revisions) {
  const facts = []; let missingAttribution = 0;
  for (const event of events) {
    let kind = null; let firstSubmission = false;
    const before = event.previousState?.status; const after = event.newState?.status;
    if (event.action === AUDIT_ACTION.TENANT_IDENTITY_CLAIMED && event.outcome === 'success'
      && event.targetType === 'tenant_identity' && event.targetId === event.tenantId
      && event.previousState === null && after === 'active' && event.metadata?.onboardingStarted === true) {
      kind = 'onboarding_started';
    } else if (event.targetType === 'request') {
      if (event.action === AUDIT_ACTION.REQUEST_STARTED && event.outcome === 'success'
        && event.previousState === null && after === 'started') kind = 'request_started';
      if (event.action === AUDIT_ACTION.REQUEST_ABANDONED && event.outcome === 'success'
        && before === 'started' && after === 'abandoned') kind = 'request_abandoned';
      if (event.action === AUDIT_ACTION.REQUEST_CREATED && event.outcome === 'success'
        && event.previousState === null && after === 'Submitted') {
        kind = 'request_submitted'; firstSubmission = true;
      }
      if (event.action === AUDIT_ACTION.REQUEST_TRANSITION && event.outcome === 'success') {
        if (before === 'Change Requested' && after === 'Submitted') kind = 'request_submitted';
        if (DECISIONS.has(after)) {
          const matches = revisions.filter((row) => row.tenantId === event.tenantId && row.requestId === event.targetId
            && row.operation === 'transitioned' && row.capturedAt === event.occurredAt && row.requestStatus === after);
          if (matches.length === 1 && matches[0].roleAtAction === 'conference_manager') kind = 'manager_decisions';
          else if (matches.length !== 1 || matches[0].roleAtAction === null) missingAttribution += 1;
        }
      }
      if (event.action === AUDIT_ACTION.REQUEST_TRANSITION_FAILED && event.outcome === 'failure') {
        kind = 'transition_failures';
      }
    }
    if (kind) facts.push({ kind, firstSubmission, tenantId: event.tenantId,
      targetId: event.targetId, occurredAt: event.occurredAt, identity: ['tenant_audit', event.id, event.eventHash] });
  }
  return { facts, missingAttribution };
}

function workflowDurations(events) {
  const starts = new Map(); const submissions = new Map(); const submitted = new Set();
  const submitTimes = []; const decisionTimes = [];
  let missingStart = 0; let missingSubmission = 0;
  for (const event of [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || Number(left.kind !== 'request_started') - Number(right.kind !== 'request_started'))) {
    const key = workflowKey(event); const at = productInstant(event.occurredAt);
    if (event.kind === 'request_started' && !starts.has(key)) starts.set(key, at);
    if (event.kind === 'request_submitted') {
      submissions.set(key, at);
      if (event.firstSubmission && !submitted.has(key)) {
        submitted.add(key);
        if (starts.has(key) && starts.get(key) <= at) submitTimes.push(at - starts.get(key));
        else missingStart += 1;
      }
    }
    if (event.kind === 'manager_decisions') {
      if (submissions.has(key) && submissions.get(key) <= at) {
        decisionTimes.push(at - submissions.get(key)); submissions.delete(key);
      } else missingSubmission += 1;
    }
  }
  return { submitTimes, decisionTimes, missingStart, missingSubmission };
}

// Input is held inside the closed repository transaction. Only aggregates and
// digests leave this function; no Tenant, User, Request or audit identity escapes.
export function compileRuntimeProductReport({ observedAt, sourceEpoch, epochStartedAt, tenant, platform, revisions,
  environment = 'demo', accessMode = 'shared_owner_password', sourceContext = null }) {
  const observed = productInstant(observedAt);
  const start = observed - 28 * DAY_MS;
  const periodStart = new Date(start).toISOString();
  const inWindow = (event) => productInstant(event.occurredAt) >= start && productInstant(event.occurredAt) < observed;
  if (tenant.state !== 'available' && platform.state !== 'available') throw new Error('PRODUCT_RUNTIME_SOURCE_UNAVAILABLE');
  const tenantResult = tenantFacts(tenant.state === 'available' ? tenant.events.filter(inWindow) : [],
    revisions.state === 'available' ? revisions.rows : []);
  const facts = [...tenantResult.facts, ...(platform.state === 'available' ? platform.events.filter(inWindow) : [])];
  if (facts.length > PRODUCT_RUNTIME_MAX_EVENTS) throw new Error('PRODUCT_RUNTIME_SOURCE_LIMIT');
  const counts = new Map();
  for (const event of facts) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  const durations = workflowDurations(facts);
  const baseState = productInstant(epochStartedAt) <= start ? 'complete' : 'partial';
  const product = []; const productCoverage = [];
  for (const id of PRODUCT_METRIC_IDS) {
    const source = TENANT_METRICS.has(id) ? tenant : platform;
    let state = source.state === 'available' ? baseState : 'not_collected';
    let reason = state === 'not_collected' ? source.reason : state === 'complete' ? 'complete_window' : 'retained_history';
    let value = state === 'not_collected' ? null : counts.get(id) ?? 0;
    let nullReason = reason;
    if (['request_started', 'request_abandoned', 'time_to_submit'].includes(id) && state !== 'not_collected') {
      // Older/API clients can submit without the new explicit start operation.
      state = 'partial'; reason = 'retained_history';
    }
    if (['manager_decisions', 'manager_decision_time'].includes(id) && state !== 'not_collected') {
      if (revisions.state !== 'available') {
        state = 'not_collected'; reason = revisions.reason; value = null; nullReason = reason;
      } else if (tenantResult.missingAttribution > 0) {
        state = 'partial'; reason = 'missing_attribution';
        if (!counts.get('manager_decisions')) { value = null; nullReason = reason; }
      }
    }
    if (id === 'time_to_submit' && state !== 'not_collected') {
      value = median(durations.submitTimes);
      nullReason = durations.missingStart ? 'missing_start_clock' : 'empty_denominator';
      if (durations.missingStart) { state = 'partial'; reason = 'missing_start_clock'; }
    }
    if (id === 'manager_decision_time' && state !== 'not_collected') {
      value = median(durations.decisionTimes);
      nullReason = tenantResult.missingAttribution ? 'missing_attribution'
        : durations.missingSubmission ? 'missing_start_clock' : 'empty_denominator';
      if (durations.missingSubmission && reason !== 'missing_attribution') {
        state = 'partial'; reason = 'missing_start_clock';
      }
    }
    if (id === 'recovery_failure_rate' && state !== 'not_collected') {
      const total = (counts.get('recovery_completed') ?? 0) + (counts.get('recovery_failed') ?? 0);
      value = total ? (counts.get('recovery_failed') ?? 0) / total : null;
      nullReason = 'empty_denominator';
    }
    product.push(productMetric(id, value, nullReason));
    productCoverage.push({ id, state, reason,
      sourcePeriodStart: state === 'not_collected' ? null : periodStart,
      sourcePeriodEnd: state === 'not_collected' ? null : observedAt });
  }
  return normalizeRuntimeProductReport({ schemaVersion: 2, environment, collectionMode: 'runtime_projection',
    accessMode, ...(environment === 'production' ? { sourceContext } : {}), observedAt, evaluatedAt: observedAt,
    periodStart, periodEnd: observedAt,
    freshness: 'fresh', sourceState: 'available', product, productCoverage,
    provenance: { mode: 'retained_runtime',
      sourceEpoch: hash(environment === 'demo' ? ['demo', sourceEpoch] : [environment, sourceEpoch, sourceContext]),
      eventCount: facts.length,
      sourceDigest: hash([sourceEpoch, observedAt, productCoverage, facts]) } }, { environment, accessMode });
}
