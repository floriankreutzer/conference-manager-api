import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
  RequestStateConflictError,
} from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  isSupportedRequestCompositionSchemaVersion,
  normalizeRequestCompositionDraft,
} from '../domain/request-composition.js';
import { isSupportedCurrencyCode } from '../domain/money.js';
import { isRequestId, toPublicRequest } from '../domain/request.js';
import { normalizeAttributionSourceDisplayName } from '../domain/request-attribution.js';
import { isIanaTimeZone } from '../domain/site-time-zone.js';
import {
  RoomAvailabilityUnavailableError,
  normalizeRoomAvailabilityQuery,
} from './room-availability-service.js';
import {
  createRequestReportCursor,
  normalizeRequestReportQuery,
} from './request-report.js';
import { fitPublicPage } from './public-page.js';
import {
  applicationCatalogContextMatches,
  createApplicationCatalogCursor,
  createApplicationCatalogContext,
  normalizeApplicationCatalogQuery,
} from './catalog-page.js';
import {
  createApplicationRequestListCursor,
  normalizeApplicationRequestListQuery,
} from './request-list.js';

const NOTIFICATION_LIMIT = 200;

export class SiteTimeZoneRequiredError extends Error {
  constructor(code = 'SITE_TIME_ZONE_REQUIRED') {
    super(code);
    this.name = 'SiteTimeZoneRequiredError';
    this.code = code;
  }
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}

function clockDate(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('APPLICATION_CLOCK_INVALID');
  return new Date(value);
}

function requireDisplayName(value) {
  if (typeof value !== 'string') throw new AuthorizationInputError('PROFILE_DISPLAY_NAME_INVALID');
  try {
    return normalizeAttributionSourceDisplayName(value);
  } catch {
    throw new AuthorizationInputError('PROFILE_DISPLAY_NAME_INVALID');
  }
}

function profileAudit(auditService, { principal, tenantContext, correlationId, changedAt }) {
  return auditService.createEvent({
    principal,
    tenantContext,
    correlationId,
    action: AUDIT_ACTION.TENANT_USER_PROFILE_UPDATED,
    targetType: 'user',
    targetId: principal.userId,
    previousState: null,
    newState: { profileUpdated: true },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'profile_update' },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    occurredAt: changedAt.toISOString(),
  });
}

export function createProductionApplicationService({
  repository,
  requestRepository,
  authorizationPolicy,
  auditService,
  roomAvailabilityService = null,
  maxResponseBytes = 1_048_576,
  cursorSecret = randomUUID(),
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !repository
    || typeof repository.findProfile !== 'function'
    || typeof repository.updateProfile !== 'function'
    || typeof repository.loadCatalogPage !== 'function'
    || typeof repository.loadSites !== 'function'
    || typeof repository.findRoomBookingContext !== 'function'
    || typeof repository.listNotifications !== 'function'
    || typeof repository.markNotificationRead !== 'function'
  ) {
    throw new TypeError('APPLICATION_REPOSITORY_REQUIRED');
  }
  if (
    !requestRepository
    || typeof requestRepository.listPageByTenantId !== 'function'
    || typeof requestRepository.listReportPageByTenantId !== 'function'
    || typeof requestRepository.createVersionedForTenant !== 'function'
    || typeof requestRepository.resubmitVersionedForTenant !== 'function'
  ) {
    throw new TypeError('REQUEST_REPOSITORY_REQUIRED');
  }
  if (
    !authorizationPolicy
    || typeof authorizationPolicy.authorizeTenantApplicationRead !== 'function'
    || typeof authorizationPolicy.authorizeRequestCreate !== 'function'
    || typeof authorizationPolicy.authorizeRequestReport !== 'function'
    || typeof authorizationPolicy.requestListScope !== 'function'
    || typeof authorizationPolicy.requireTenantPermission !== 'function'
  ) {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (
    roomAvailabilityService !== null
    && typeof roomAvailabilityService?.checkAvailability !== 'function'
  ) {
    throw new TypeError('ROOM_AVAILABILITY_SERVICE_INVALID');
  }
  if (typeof clock !== 'function' || typeof idFactory !== 'function') {
    throw new TypeError('APPLICATION_RUNTIME_INVALID');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024) {
    throw new TypeError('APPLICATION_RESPONSE_BYTES_INVALID');
  }
  if (typeof cursorSecret !== 'string' || Buffer.byteLength(cursorSecret) < 32) {
    throw new TypeError('APPLICATION_CURSOR_SECRET_INVALID');
  }

  function authorizeRead(principal, tenantContext) {
    authorizationPolicy.authorizeTenantApplicationRead(principal, tenantContext);
  }

  async function requireBookableRoom(tenantId, roomId) {
    const context = await repository.findRoomBookingContext(tenantId, roomId);
    if (!context || context.roomActive !== true || context.siteActive !== true) {
      throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
    }
    if (!isIanaTimeZone(context.timeZone)) throw new SiteTimeZoneRequiredError();
  }

  return Object.freeze({
    async getProfile({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorizeRead(principal, tenantContext);
      const profile = await repository.findProfile(tenantContext.tenantId, principal.userId);
      if (!profile) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      return profile;
    },

    async updateProfile({ principal, tenantContext, correlationId, profile }) {
      requireCorrelationId(correlationId);
      authorizeRead(principal, tenantContext);
      const displayName = requireDisplayName(profile?.displayName);
      const changedAt = clockDate(clock);
      const updated = await repository.updateProfile({
        tenantId: tenantContext.tenantId,
        userId: principal.userId,
        displayName,
        changedAt,
        auditEvent: profileAudit(auditService, {
          principal,
          tenantContext,
          correlationId,
          changedAt,
        }),
      });
      if (!updated) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      return updated;
    },

    async getCatalog({ principal, tenantContext, correlationId, query }) {
      requireCorrelationId(correlationId);
      authorizeRead(principal, tenantContext);
      const page = normalizeApplicationCatalogQuery(query);
      const loaded = await repository.loadCatalogPage({
        tenantId: tenantContext.tenantId,
        section: page.section,
        afterId: page.afterId,
        limit: page.limit + 1,
        expectedRevisions: page.expectedRevisions,
        expectedPolicyVersionId: page.expectedPolicyVersionId,
      });
      if (loaded?.status === 'stale') throw new RequestStateConflictError();
      if (loaded?.status !== 'ready' || !applicationCatalogContextMatches(loaded, page)) {
        throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      }
      if (
        !isSupportedCurrencyCode(loaded.defaultCurrency)
        || !Array.isArray(loaded.entries)
        || loaded.entries.length > page.limit + 1
      ) {
        throw new TypeError('APPLICATION_CATALOGUE_PAGE_INVALID');
      }
      return fitPublicPage({
        items: loaded.entries,
        limit: page.limit,
        maxResponseBytes,
        cursorFor: (last) => createApplicationCatalogCursor({
          section: page.section,
          revisions: loaded.configurationRevisions,
          policyVersionId: loaded.bookingPolicy.policyVersionId,
          afterId: last.id,
        }),
        resultFor: (entries, publicPage) => Object.freeze({
          schemaVersion: 2,
          configurationRevisions: loaded.configurationRevisions,
          bookingPolicy: loaded.bookingPolicy,
          organization: Object.freeze({ defaultCurrency: loaded.defaultCurrency }),
          costAllocation: Object.freeze({
            allocationRequired: loaded.allocationRequired,
          }),
          context: createApplicationCatalogContext({
            revisions: loaded.configurationRevisions,
            policyVersionId: loaded.bookingPolicy.policyVersionId,
          }),
          section: page.section,
          entries,
          page: publicPage,
        }),
        envelopeFor: (catalog) => catalog,
      });
    },

    async getSiteInfo(args) {
      requireCorrelationId(args.correlationId);
      authorizeRead(args.principal, args.tenantContext);
      return Object.freeze({ sites: await repository.loadSites(args.tenantContext.tenantId) });
    },

    async listRequests({ principal, tenantContext, correlationId, query }) {
      requireCorrelationId(correlationId);
      const scope = authorizationPolicy.requestListScope(principal, tenantContext);
      const page = normalizeApplicationRequestListQuery(query, {
        tenantId: tenantContext.tenantId,
        requesterUserId: scope.requesterUserId,
        cursorSecret,
        evaluatedAt: clockDate(clock).toISOString(),
      });
      const loaded = await requestRepository.listPageByTenantId({
        tenantId: tenantContext.tenantId,
        requesterUserId: scope.requesterUserId,
        snapshot: page.snapshot,
        afterStartsAt: page.afterStartsAt === null ? null : new Date(page.afterStartsAt),
        afterRequestId: page.afterRequestId,
        limit: page.limit + 1,
      });
      if (
        loaded?.status !== 'ready'
        || !loaded.snapshot
        || !Number.isSafeInteger(loaded.snapshot.revisionWatermark)
        || loaded.snapshot.revisionWatermark < 0
        || typeof loaded.snapshot.asOf !== 'string'
        || Number.isNaN(Date.parse(loaded.snapshot.asOf))
        || !Array.isArray(loaded.requests)
        || loaded.requests.length > page.limit + 1
      ) throw new TypeError('APPLICATION_REQUEST_LIST_RESULT_INVALID');
      return fitPublicPage({
        items: loaded.requests,
        limit: page.limit,
        maxResponseBytes,
        cursorFor: (last) => createApplicationRequestListCursor({
          requesterUserId: scope.requesterUserId,
          tenantId: tenantContext.tenantId,
          snapshot: loaded.snapshot,
          startsAt: last.startsAt,
          requestId: last.id,
        }, { cursorSecret }),
        resultFor: (requests, publicPage) => Object.freeze({
          schemaVersion: 3,
          asOf: loaded.snapshot.asOf,
          requests,
          page: publicPage,
        }),
        envelopeFor: (requestList) => requestList,
      });
    },

    async getRequestReport({ principal, tenantContext, correlationId, query }) {
      requireCorrelationId(correlationId);
      authorizationPolicy.authorizeRequestReport(principal, tenantContext);
      const page = normalizeRequestReportQuery(query, {
        tenantId: tenantContext.tenantId,
        cursorSecret,
        evaluatedAt: clockDate(clock).toISOString(),
      });
      const loaded = await requestRepository.listReportPageByTenantId({
        tenantId: tenantContext.tenantId,
        from: new Date(page.from),
        to: new Date(page.to),
        snapshot: page.snapshot,
        afterStartsAt: page.after.startsAt === null ? null : new Date(page.after.startsAt),
        afterRequestId: page.after.requestId,
        limit: page.limit + 1,
      });
      if (
        loaded?.status !== 'ready'
        || !loaded.snapshot
        || !Number.isSafeInteger(loaded.snapshot.revisionWatermark)
        || loaded.snapshot.revisionWatermark < 0
        || typeof loaded.snapshot.asOf !== 'string'
        || Number.isNaN(Date.parse(loaded.snapshot.asOf))
        || !Array.isArray(loaded.requests)
        || loaded.requests.length > page.limit + 1
      ) {
        throw new TypeError('REQUEST_REPORT_RESULT_INVALID');
      }
      return fitPublicPage({
        items: loaded.requests,
        limit: page.limit,
        maxResponseBytes,
        cursorFor: (last) => createRequestReportCursor({
          tenantId: tenantContext.tenantId,
          from: page.from,
          to: page.to,
          snapshot: loaded.snapshot,
          startsAt: last.startsAt,
          requestId: last.id,
        }, { cursorSecret }),
        resultFor: (requests, publicPage) => Object.freeze({
          schemaVersion: 3,
          asOf: loaded.snapshot.asOf,
          range: Object.freeze({
            field: 'startsAt',
            fromInclusive: page.from,
            toExclusive: page.to,
            timeZone: 'UTC',
          }),
          requests,
          page: publicPage,
        }),
        envelopeFor: (report) => report,
      });
    },

    async createRequest({
      principal,
      tenantContext,
      correlationId,
      schemaVersion,
      requestDraft,
    }) {
      requireCorrelationId(correlationId);
      authorizationPolicy.authorizeRequestCreate(principal, tenantContext);
      if (!isSupportedRequestCompositionSchemaVersion(schemaVersion)) {
        throw new AuthorizationInputError('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
      }
      const draft = normalizeRequestCompositionDraft(requestDraft, schemaVersion);
      const requestId = idFactory();
      if (!isInternalUuid(requestId)) throw new TypeError('REQUEST_ID_FACTORY_INVALID');
      const createdAt = clockDate(clock);
      const auditEvent = auditService.createEvent({
        principal,
        tenantContext,
        correlationId,
        action: AUDIT_ACTION.REQUEST_CREATED,
        targetType: 'request',
        targetId: requestId,
        previousState: null,
        newState: { status: 'Submitted', schemaVersion, requestVersion: 1 },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { operation: 'request_create' },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
        occurredAt: createdAt.toISOString(),
      });
      const result = await requestRepository.createVersionedForTenant({
        tenantId: tenantContext.tenantId,
        requestId,
        requesterUserId: principal.userId,
        schemaVersion,
        requestDraft: draft,
        createdAt,
        auditEvent,
      });
      if (result?.status === 'configuration_conflict') throw new RequestStateConflictError();
      if (result?.status !== 'created' || !result.request) {
        throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      }
      return toPublicRequest(result.request);
    },

    async resubmitRequest({
      principal,
      tenantContext,
      correlationId,
      requestId,
      schemaVersion,
      expectedVersion,
      requestDraft,
    }) {
      requireCorrelationId(correlationId);
      authorizationPolicy.authorizeRequestCreate(principal, tenantContext);
      if (!isRequestId(requestId)) throw new AuthorizationInputError('REQUEST_ID_INVALID');
      if (!isSupportedRequestCompositionSchemaVersion(schemaVersion)) {
        throw new AuthorizationInputError('REQUEST_SCHEMA_VERSION_UNSUPPORTED');
      }
      if (
        !Number.isSafeInteger(expectedVersion)
        || expectedVersion < 1
        || expectedVersion >= Number.MAX_SAFE_INTEGER
      ) {
        throw new AuthorizationInputError('REQUEST_VERSION_INVALID');
      }
      const draft = normalizeRequestCompositionDraft(requestDraft, schemaVersion);
      const changedAt = clockDate(clock);
      const auditEvent = auditService.createEvent({
        principal,
        tenantContext,
        correlationId,
        action: AUDIT_ACTION.REQUEST_TRANSITION,
        targetType: 'request',
        targetId: requestId,
        previousState: { status: 'Change Requested', requestVersion: expectedVersion },
        newState: { status: 'Submitted', schemaVersion, requestVersion: expectedVersion + 1 },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { operation: 'request_resubmit', transition: 'resubmit' },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
        occurredAt: changedAt.toISOString(),
      });
      const result = await requestRepository.resubmitVersionedForTenant({
        tenantId: tenantContext.tenantId,
        requestId,
        requesterUserId: principal.userId,
        schemaVersion,
        expectedVersion,
        requestDraft: draft,
        changedAt,
        auditEvent,
      });
      if (result?.status === 'not_found') {
        throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      }
      if (['state_conflict', 'configuration_conflict'].includes(result?.status)) {
        throw new RequestStateConflictError();
      }
      if (result?.status !== 'resubmitted' || !result.request) {
        throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      }
      return toPublicRequest(result.request);
    },

    async checkRoomAvailability({ principal, tenantContext, correlationId, query }) {
      if (!roomAvailabilityService) throw new RoomAvailabilityUnavailableError();
      requireCorrelationId(correlationId);
      authorizationPolicy.authorizeRequestCreate(principal, tenantContext);
      const normalized = normalizeRoomAvailabilityQuery(query);
      await requireBookableRoom(tenantContext.tenantId, normalized.roomId);
      return roomAvailabilityService.checkAvailability({
        principal,
        tenantContext,
        correlationId,
        query: normalized,
      });
    },

    async listNotifications({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorizeRead(principal, tenantContext);
      return repository.listNotifications(tenantContext.tenantId, principal.userId, NOTIFICATION_LIMIT);
    },

    async markNotificationRead({ principal, tenantContext, correlationId, notificationId }) {
      requireCorrelationId(correlationId);
      authorizeRead(principal, tenantContext);
      if (!isInternalUuid(notificationId)) throw new AuthorizationInputError('NOTIFICATION_ID_INVALID');
      const updated = await repository.markNotificationRead(
        tenantContext.tenantId,
        principal.userId,
        notificationId,
        clockDate(clock),
      );
      if (!updated) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      return updated;
    },

    async getConfiguration({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_CONFIGURE,
      );
      return Object.freeze({ sites: await repository.loadSites(tenantContext.tenantId) });
    },
  });
}
