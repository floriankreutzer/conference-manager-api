import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { AuditInputError, AuditIntegrityError } from './errors.js';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from './event.js';

export const TENANT_AUDIT_CATEGORY = Object.freeze({
  USER: 'user',
  CONFIGURATION: 'configuration',
  REQUEST: 'request',
  INTEGRATION: 'integration',
  SECURITY: 'security',
});

const CATEGORY_BY_ACTION = new Map([
  [AUDIT_ACTION.SESSION_ISSUED, TENANT_AUDIT_CATEGORY.SECURITY],
  [AUDIT_ACTION.SESSION_REVOKED, TENANT_AUDIT_CATEGORY.SECURITY],
  [AUDIT_ACTION.SESSION_ROTATED, TENANT_AUDIT_CATEGORY.SECURITY],
  [AUDIT_ACTION.AUTHENTICATION_FAILED, TENANT_AUDIT_CATEGORY.SECURITY],
  [AUDIT_ACTION.AUTHORIZATION_DENIED, TENANT_AUDIT_CATEGORY.SECURITY],
  [AUDIT_ACTION.AUDIT_READ, TENANT_AUDIT_CATEGORY.SECURITY],
  [AUDIT_ACTION.REQUEST_CREATED, TENANT_AUDIT_CATEGORY.REQUEST],
  [AUDIT_ACTION.REQUEST_TRANSITION, TENANT_AUDIT_CATEGORY.REQUEST],
  [AUDIT_ACTION.REQUEST_TRANSITION_FAILED, TENANT_AUDIT_CATEGORY.REQUEST],
  [AUDIT_ACTION.REQUEST_BOOKING_CHANGE, TENANT_AUDIT_CATEGORY.REQUEST],
  [AUDIT_ACTION.CALENDAR_OPERATION, TENANT_AUDIT_CATEGORY.REQUEST],
  [AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED, TENANT_AUDIT_CATEGORY.USER],
  [AUDIT_ACTION.TENANT_USER_PROVISIONED, TENANT_AUDIT_CATEGORY.USER],
  [AUDIT_ACTION.TENANT_USER_PROFILE_UPDATED, TENANT_AUDIT_CATEGORY.USER],
  [AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED, TENANT_AUDIT_CATEGORY.CONFIGURATION],
  [AUDIT_ACTION.TENANT_ENTITLEMENT_CHANGED, TENANT_AUDIT_CATEGORY.CONFIGURATION],
  [AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED, TENANT_AUDIT_CATEGORY.CONFIGURATION],
  [AUDIT_ACTION.TENANT_ONBOARDING_INVITED, TENANT_AUDIT_CATEGORY.CONFIGURATION],
  [AUDIT_ACTION.TENANT_IDENTITY_CLAIMED, TENANT_AUDIT_CATEGORY.INTEGRATION],
  [AUDIT_ACTION.TENANT_IDENTITY_UNBOUND, TENANT_AUDIT_CATEGORY.INTEGRATION],
  [AUDIT_ACTION.INTEGRATION_CONNECTED, TENANT_AUDIT_CATEGORY.INTEGRATION],
  [AUDIT_ACTION.INTEGRATION_DISCONNECTED, TENANT_AUDIT_CATEGORY.INTEGRATION],
  [AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED, TENANT_AUDIT_CATEGORY.INTEGRATION],
  [AUDIT_ACTION.INTEGRATION_VERIFIED, TENANT_AUDIT_CATEGORY.INTEGRATION],
]);
const ACTIONS_BY_CATEGORY = new Map(Object.values(TENANT_AUDIT_CATEGORY).map((category) => [
  category,
  Object.freeze([...CATEGORY_BY_ACTION.entries()]
    .filter(([, candidate]) => candidate === category)
    .map(([action]) => action)),
]));
const OUTCOMES = new Set(Object.values(AUDIT_OUTCOME));
const MAX_AUDIT_ID = 9_223_372_036_854_775_807n;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const SUMMARY_KEYS = new Set([
  'active',
  'activeCateringItemCount',
  'activeEquipmentCount',
  'activePackageCount',
  'activeServiceCount',
  'brandingChanged',
  'businessMetadataChanged',
  'cateringItemCount',
  'conferenceManager',
  'currencyChanged',
  'displayNameChanged',
  'enabled',
  'equipmentCount',
  'lifecycleVersion',
  'localeChanged',
  'openRequestCount',
  'packageCount',
  'profileUpdated',
  'provider',
  'providerStatus',
  'revision',
  'revokedSessionCount',
  'roomCount',
  'serviceCount',
  'siteCount',
  'sourceRevision',
  'status',
  'tenantAdmin',
]);

function canonicalInstant(value, code) {
  if (
    typeof value !== 'string'
    || !value.endsWith('Z')
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new AuditInputError(code);
  }
  return value;
}

function normalizeWindow({ from = null, to = null }, clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new AuditInputError('AUDIT_CLOCK_INVALID');
  const toValue = to === null ? new Date(now).toISOString() : canonicalInstant(to, 'AUDIT_TO_INVALID');
  const toMs = Date.parse(toValue);
  const fromValue = from === null
    ? new Date(toMs - DEFAULT_WINDOW_MS).toISOString()
    : canonicalInstant(from, 'AUDIT_FROM_INVALID');
  const fromMs = Date.parse(fromValue);
  if (fromMs >= toMs || toMs - fromMs > MAX_WINDOW_MS || toMs > now + MAX_FUTURE_SKEW_MS) {
    throw new AuditInputError('AUDIT_WINDOW_INVALID');
  }
  return Object.freeze({ from: fromValue, to: toValue });
}

function normalizePage({
  limit = 50,
  beforeId = null,
  category = null,
  outcome = null,
  actorUserId = null,
  from = null,
  to = null,
} = {}, clock) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AuditInputError('AUDIT_LIMIT_INVALID');
  }
  if (
    beforeId !== null
    && (
      typeof beforeId !== 'string'
      || !/^[1-9]\d{0,18}$/.test(beforeId)
      || BigInt(beforeId) > MAX_AUDIT_ID
    )
  ) {
    throw new AuditInputError('AUDIT_CURSOR_INVALID');
  }
  if (category !== null && !ACTIONS_BY_CATEGORY.has(category)) {
    throw new AuditInputError('AUDIT_CATEGORY_INVALID');
  }
  if (outcome !== null && !OUTCOMES.has(outcome)) {
    throw new AuditInputError('AUDIT_OUTCOME_INVALID');
  }
  if (actorUserId !== null && !isInternalUuid(actorUserId)) {
    throw new AuditInputError('AUDIT_ACTOR_INVALID');
  }
  return Object.freeze({
    limit,
    beforeId,
    category,
    categoryActions: category === null ? null : ACTIONS_BY_CATEGORY.get(category),
    outcome,
    actorUserId,
    window: normalizeWindow({ from, to }, clock),
  });
}

function safeSummary(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = {};
  for (const key of [...SUMMARY_KEYS].sort()) {
    const entry = value[key];
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      summary[key] = entry;
    }
  }
  return Object.keys(summary).length === 0 ? null : Object.freeze(summary);
}

function publicTarget(event) {
  if (event.targetType === 'integration' || event.targetType === 'tenant') {
    return Object.freeze({ type: event.targetType, id: null });
  }
  return Object.freeze({ type: event.targetType, id: event.targetId });
}

function publicEvent(event, tenantId) {
  const category = CATEGORY_BY_ACTION.get(event?.action);
  if (
    !event
    || event.tenantId !== tenantId
    || !category
    || typeof event.id !== 'string'
    || !/^[1-9]\d{0,18}$/.test(event.id)
    || (event.actorUserId !== null && !isInternalUuid(event.actorUserId))
    || !isInternalUuid(event.correlationId)
    || !OUTCOMES.has(event.outcome)
    || typeof event.targetType !== 'string'
    || typeof event.targetId !== 'string'
  ) {
    throw new AuditIntegrityError('AUDIT_QUERY_RESULT_INVALID');
  }
  let occurredAt;
  try {
    occurredAt = canonicalInstant(event.occurredAt, 'AUDIT_OCCURRED_AT_INVALID');
  } catch (error) {
    if (error instanceof AuditInputError) {
      throw new AuditIntegrityError('AUDIT_QUERY_RESULT_INVALID');
    }
    throw error;
  }
  const metadataSummary = safeSummary(event.metadata);
  return Object.freeze({
    id: event.id,
    category,
    action: event.action,
    actor: Object.freeze({ userId: event.actorUserId }),
    target: publicTarget(event),
    outcome: event.outcome,
    occurredAt,
    correlationId: event.correlationId,
    change: Object.freeze({
      before: safeSummary(event.previousState),
      after: safeSummary(event.newState),
      ...(metadataSummary === null ? {} : { summary: metadataSummary }),
    }),
  });
}

export function createTenantAuditQueryService({
  queryRepository,
  integrityRepository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  if (!queryRepository || typeof queryRepository.listByTenantId !== 'function') {
    throw new TypeError('TENANT_AUDIT_QUERY_REPOSITORY_REQUIRED');
  }
  if (!integrityRepository || typeof integrityRepository.verifyTenantChain !== 'function') {
    throw new TypeError('AUDIT_INTEGRITY_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.record !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('AUDIT_CLOCK_REQUIRED');

  return Object.freeze({
    async listEvents({ principal, tenantContext, correlationId, ...pageValues }) {
      if (!isInternalUuid(correlationId)) throw new AuditInputError('AUDIT_CORRELATION_INVALID');
      try {
        authorizationPolicy.requireTenantPermission(
          principal,
          tenantContext,
          PERMISSION.TENANT_AUDIT_READ,
        );
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          await auditService.recordAuthorizationDenied({
            principal,
            tenantContext,
            correlationId,
            targetType: 'audit',
            targetId: 'tenant-audit-query',
            metadata: { operation: 'query' },
          });
        }
        throw error;
      }
      const page = normalizePage(pageValues, clock);
      if (await integrityRepository.verifyTenantChain(tenantContext.tenantId) !== true) {
        throw new AuditIntegrityError();
      }
      const rows = await queryRepository.listByTenantId({
        tenantId: tenantContext.tenantId,
        limit: page.limit + 1,
        beforeId: page.beforeId,
        categoryActions: page.categoryActions,
        outcome: page.outcome,
        actorUserId: page.actorUserId,
        from: page.window.from,
        to: page.window.to,
      });
      if (!Array.isArray(rows)) throw new AuditIntegrityError('AUDIT_QUERY_RESULT_INVALID');
      const hasMore = rows.length > page.limit;
      const events = rows.slice(0, page.limit).map((event) => publicEvent(
        event,
        tenantContext.tenantId,
      ));
      await auditService.record({
        principal,
        tenantContext,
        correlationId,
        action: AUDIT_ACTION.AUDIT_READ,
        targetType: 'audit',
        targetId: 'tenant-audit',
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: {
          filtered: page.category !== null || page.outcome !== null || page.actorUserId !== null,
          resultCount: events.length,
        },
        retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
      });
      return Object.freeze({
        events: Object.freeze(events),
        nextBeforeId: hasMore ? events.at(-1)?.id || null : null,
        window: page.window,
      });
    },
  });
}
