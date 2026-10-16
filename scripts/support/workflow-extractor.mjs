import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PERMISSION } from '../../src/authorization/policy.js';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { isRequestId } from '../../src/domain/request.js';
import { AUDIT_ACTION } from '../../src/audit/event.js';
import { PLATFORM_AUDIT_ACTION } from '../../src/platform/audit/event.js';
import { PLATFORM_PERMISSION } from '../../src/platform/identity/policy.js';
import { normalizePlatformPrincipal } from '../../src/platform/identity/principal.js';
import { DAY_MS, productInstant } from '../../src/observability/product-delivery-contract.js';
import { compileProductDeliveryReport } from '../../src/observability/product-delivery-report.js';
import { OPERATIONS_SOURCE_MAX_BYTES } from '../../src/observability/operations-source-contract.js';

const DECISIONS = new Set(['Confirmed', 'Rejected', 'Change Requested']);
const MAX_ROWS = 2000;
const TENANT_ACTIONS = new Set([AUDIT_ACTION.REQUEST_CREATED, AUDIT_ACTION.REQUEST_TRANSITION,
  AUDIT_ACTION.REQUEST_TRANSITION_FAILED]);

function requireSource(condition) {
  if (!condition) throw new TypeError('WORKFLOW_EXTRACTION_FAILED');
}

// These are existing authenticated application services, not caller-supplied JSON
// or an HTTP ingestion route. The server/operator owns the immutable source epoch.
export function createWorkflowExtractor({ tenantAuditQueryService, requestService,
  platformAuditService, authorizationPolicy, platformAuthorizationPolicy, sourceEpoch, readSourceEpoch,
  environment, clock = Date.now,
  deadlineMs = 30000 } = {}) {
  if (typeof tenantAuditQueryService?.listEvents !== 'function'
    || typeof requestService?.getRequestHistory !== 'function'
    || typeof platformAuditService?.list !== 'function'
    || typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || typeof platformAuthorizationPolicy?.authorize !== 'function' || typeof readSourceEpoch !== 'function'
    || typeof sourceEpoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceEpoch)
    || !['demo', 'production'].includes(environment) || typeof clock !== 'function'
    || !Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 30000) {
    throw new TypeError('WORKFLOW_EXTRACTOR_CONFIG_INVALID');
  }
  let pendingReads = 0;

  function collection() {
    const started = performance.now();
    const observed = clock();
    requireSource(Number.isSafeInteger(observed) && observed >= 28 * DAY_MS);
    const end = Math.floor(observed / DAY_MS) * DAY_MS;
    const start = end - 28 * DAY_MS;
    let lastClock = observed; let rowsRead = 0;
    const events = [];
    function time() {
      const value = clock();
      requireSource(Number.isSafeInteger(value) && value >= lastClock && value - observed < deadlineMs
        && performance.now() - started < deadlineMs);
      lastClock = value; return value;
    }
    async function read(operation) {
      const remaining = Math.min(observed + deadlineMs - time(), deadlineMs - (performance.now() - started));
      let timer;
      try {
        // Existing service/repository dependency bounds still own cancellation.
        // Never start another read after timeout or publish a partial result.
        pendingReads += 1;
        const work = Promise.resolve().then(operation).finally(() => { pendingReads -= 1; });
        return await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('WORKFLOW_EXTRACTION_FAILED')), remaining);
        })]);
      } finally { clearTimeout(timer); time(); }
    }
    function consume(rows, maximum) {
      requireSource(Array.isArray(rows) && rows.length <= maximum);
      rowsRead += rows.length; requireSource(rowsRead <= MAX_ROWS);
    }
    function add(source, identity, kind, tenantId, targetId, occurredAt) {
      requireSource(isInternalUuid(tenantId) && typeof targetId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(targetId));
      const at = productInstant(occurredAt);
      requireSource(at >= start && at < end && events.length < MAX_ROWS);
      const sourceId = createHash('sha256').update(JSON.stringify([
        environment, sourceEpoch, source, tenantId.toLowerCase(), identity,
      ])).digest('hex');
      events.push({ source, sourceId, kind, tenantId: tenantId.toLowerCase(), targetId, occurredAt });
    }
    async function verifyEpoch() { requireSource(await read(readSourceEpoch) === sourceEpoch); }
    async function finish() {
      await verifyEpoch();
      time();
      const value = { schemaVersion: 1, environment, observedAt: new Date(observed).toISOString(),
        periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString(),
        productComplete: false, productEvents: Object.freeze(events.map(event => Object.freeze(event))),
        deliveryComplete: { application: false, api: false, website: false }, deployments: [],
        feedbackSource: 'not_configured', feedbackComplete: false, feedback: [] };
      // Reserve bounded envelope space for the existing conditional source writer.
      requireSource(Buffer.byteLength(JSON.stringify(value)) <= OPERATIONS_SOURCE_MAX_BYTES - 4096);
      compileProductDeliveryReport(value);
      return Object.freeze(value);
    }
    return { observed, start, end, read, consume, add, finish, verifyEpoch };
  }

  async function tenant(values) {
    requireSource(values && Object.keys(values).sort().join(',') === 'correlationId,principal,tenantContext');
    const { principal, tenantContext, correlationId } = values;
    requireSource(isInternalUuid(correlationId));
    // Both pre-existing capabilities are required; Tenant Admin and Manager do
    // not inherit each other's authority and Platform credentials grant neither.
    authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_AUDIT_READ);
    authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.REQUEST_MANAGE);
    requireSource(isInternalUuid(principal.tenantId) && principal.tenantId === tenantContext.tenantId);
    const c = collection(); const tenantId = principal.tenantId;
    await c.verifyEpoch();
    const decisions = []; let beforeId = null;
    do {
      const page = await c.read(() => tenantAuditQueryService.listEvents({ principal, tenantContext, correlationId,
        limit: 100, beforeId, category: 'request',
        from: new Date(c.start).toISOString(), to: new Date(c.end - 1).toISOString() }));
      c.consume(page?.events, 100);
      requireSource(page.window?.from === new Date(c.start).toISOString()
        && page.window?.to === new Date(c.end - 1).toISOString());
      let previous = beforeId;
      for (const event of page.events) {
        requireSource(typeof event.id === 'string' && /^[1-9]\d{0,18}$/.test(event.id)
          && (previous === null || BigInt(event.id) < BigInt(previous))
          && isInternalUuid(event.correlationId)
          && ['success', 'failure', 'denied'].includes(event.outcome));
        previous = event.id;
        const at = productInstant(event.occurredAt); requireSource(at >= c.start && at < c.end);
        if (!TENANT_ACTIONS.has(event.action)) continue;
        requireSource(event.target?.type === 'request' && isRequestId(event.target.id));
        const identity = [event.id, event.correlationId];
        if (event.action === AUDIT_ACTION.REQUEST_CREATED && event.outcome === 'success') {
          requireSource(event.change?.before === null && event.change?.after?.status === 'Submitted');
          c.add('tenant_audit', identity, 'request_submitted', tenantId, event.target.id, event.occurredAt);
        } else if (event.action === AUDIT_ACTION.REQUEST_TRANSITION && event.outcome === 'success') {
          if (event.change?.after?.status === 'Submitted') {
            requireSource(event.change?.before?.status === 'Change Requested');
            c.add('tenant_audit', identity, 'request_submitted', tenantId, event.target.id, event.occurredAt);
          } else if (DECISIONS.has(event.change?.after?.status)) decisions.push(event);
        } else if (event.action === AUDIT_ACTION.REQUEST_TRANSITION_FAILED && event.outcome === 'failure') {
          c.add('tenant_audit', identity, 'transition_failure', tenantId, event.target.id, event.occurredAt);
        }
      }
      requireSource(page.nextBeforeId === null || (page.events.length > 0 && page.nextBeforeId === previous));
      beforeId = page.nextBeforeId;
    } while (beforeId !== null);

    const histories = new Map();
    for (const event of decisions) {
      const targetId = event.target.id;
      if (!histories.has(targetId)) {
        requireSource(histories.size < 100);
        const rows = []; let cursor; let asOfVersion = null; let previousVersion = Infinity;
        do {
          const page = await c.read(() => requestService.getRequestHistory({ principal, tenantContext, correlationId,
            requestId: targetId, query: { limit: '10', cursor } }));
          c.consume(page?.history, 10);
          requireSource(Number.isSafeInteger(page.asOfVersion) && page.asOfVersion > 0
            && (asOfVersion === null || page.asOfVersion === asOfVersion)
            && typeof page.page?.complete === 'boolean');
          asOfVersion = page.asOfVersion;
          for (const entry of page.history) {
            requireSource(Number.isSafeInteger(entry.version) && entry.version > 0
              && entry.version <= asOfVersion && entry.version < previousVersion
              && entry.request?.id === targetId && entry.request?.version === entry.version);
            productInstant(entry.capturedAt); previousVersion = entry.version; rows.push(entry);
          }
          const next = page.page.nextCursor;
          requireSource(page.page.complete ? next === null : page.history.length > 0
            && typeof next === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(next) && next !== cursor);
          cursor = page.page.complete ? undefined : next;
        } while (cursor !== undefined);
        histories.set(targetId, rows);
      }
      const matches = histories.get(targetId).filter(row => row.operation === 'transitioned'
        && row.actorAttribution?.roleAtAction === 'conference_manager'
        && row.capturedAt === event.occurredAt && row.request.status === event.change.after.status);
      requireSource(matches.length === 1);
      c.add('request_revision', [targetId, matches[0].version], 'manager_decision', tenantId, targetId, event.occurredAt);
    }
    return c.finish();
  }

  async function platform(values) {
    requireSource(values && Object.keys(values).sort().join(',') === 'correlationId,principal'
      && isInternalUuid(values.correlationId));
    const principal = normalizePlatformPrincipal(values.principal);
    requireSource(await platformAuthorizationPolicy.authorize(principal, PLATFORM_PERMISSION.AUDIT_READ) === true);
    const c = collection(); let beforeSequence = null;
    await c.verifyEpoch();
    while (true) {
      const rows = await c.read(() => platformAuditService.list({ ...values, limit: 100, beforeSequence }));
      c.consume(rows, 100); if (rows.length === 0) break;
      let previous = beforeSequence ?? Infinity;
      for (const event of rows) {
        requireSource(Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.sequence < previous
          && isInternalUuid(event.correlationId) && ['success', 'failure', 'denied'].includes(event.outcome));
        previous = event.sequence;
        const at = productInstant(event.occurredAt); requireSource(at <= c.observed);
        if (at < c.start || at >= c.end || event.targetTenantId === null) continue;
        const before = event.previousState?.status; const after = event.newState?.status;
        let kind = null;
        if (event.action === PLATFORM_AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED && event.outcome === 'success') {
          if (before === 'pending' && after === 'onboarding') kind = 'onboarding_started';
          if (before === 'onboarding' && after === 'ready') kind = 'onboarding_completed';
        } else if (event.action === PLATFORM_AUDIT_ACTION.RECOVERY_EXECUTED) {
          if (event.outcome === 'success') kind = 'recovery_completed';
          if (event.outcome === 'failure') kind = 'recovery_failed';
        }
        if (kind) c.add('platform_audit', [event.sequence, event.correlationId], kind,
          event.targetTenantId, event.targetId, event.occurredAt);
      }
      beforeSequence = previous;
      if (rows.length < 100) break;
    }
    return c.finish();
  }
  let busy = false;
  function guarded(operation) {
    return async values => {
      if (busy || pendingReads > 0) throw new Error('WORKFLOW_EXTRACTION_FAILED');
      busy = true;
      try { return await operation(values); }
      catch { throw new Error('WORKFLOW_EXTRACTION_FAILED'); }
      finally { busy = false; }
    };
  }
  return Object.freeze({ collectTenant: guarded(tenant), collectPlatform: guarded(platform) });
}
