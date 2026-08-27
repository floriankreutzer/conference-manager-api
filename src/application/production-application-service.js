import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationDeniedError, AuthorizationInputError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { isIanaTimeZone } from '../domain/site-time-zone.js';
import {
  RoomAvailabilityUnavailableError,
  normalizeRoomAvailabilityQuery,
} from './room-availability-service.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DISPLAY_NAME_MAX = 160;
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
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > DISPLAY_NAME_MAX
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AuthorizationInputError('PROFILE_DISPLAY_NAME_INVALID');
  }
  return normalized;
}

function requireRequestDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthorizationInputError('REQUEST_DRAFT_INVALID');
  }
  const allowed = new Set([
    'roomId',
    'startsAt',
    'endsAt',
    'internalParticipants',
    'externalParticipants',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AuthorizationInputError('REQUEST_DRAFT_INVALID');
  }
  if (typeof value.roomId !== 'string' || !SAFE_ID.test(value.roomId)) {
    throw new AuthorizationInputError('REQUEST_ROOM_INVALID');
  }
  let schedule;
  try {
    schedule = normalizeRoomAvailabilityQuery({
      roomId: value.roomId,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
    });
  } catch (error) {
    if (!(error instanceof AuthorizationInputError)) throw error;
    throw new AuthorizationInputError('REQUEST_SCHEDULE_INVALID');
  }
  const internalParticipants = value.internalParticipants ?? 0;
  const externalParticipants = value.externalParticipants ?? 0;
  if (
    !Number.isSafeInteger(internalParticipants)
    || internalParticipants < 0
    || internalParticipants > 100_000
    || !Number.isSafeInteger(externalParticipants)
    || externalParticipants < 0
    || externalParticipants > 100_000
  ) {
    throw new AuthorizationInputError('REQUEST_PARTICIPANTS_INVALID');
  }
  if (internalParticipants + externalParticipants < 1) {
    throw new AuthorizationInputError('REQUEST_PARTICIPANTS_INVALID');
  }
  return Object.freeze({
    roomId: value.roomId,
    startsAt: new Date(schedule.startsAt),
    endsAt: new Date(schedule.endsAt),
    internalParticipants,
    externalParticipants,
  });
}

function publicRequest(request) {
  return Object.freeze({
    id: request.id,
    roomId: request.roomId,
    status: request.status,
    statusReason: request.statusReason,
    startsAt: request.startsAt,
    endsAt: request.endsAt,
    internalParticipants: request.internalParticipants,
    externalParticipants: request.externalParticipants,
    statusChangedAt: request.statusChangedAt,
    updatedAt: request.updatedAt,
  });
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
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !repository
    || typeof repository.findProfile !== 'function'
    || typeof repository.updateProfile !== 'function'
    || typeof repository.loadCatalog !== 'function'
    || typeof repository.findRoomBookingContext !== 'function'
    || typeof repository.listNotifications !== 'function'
    || typeof repository.markNotificationRead !== 'function'
  ) {
    throw new TypeError('APPLICATION_REPOSITORY_REQUIRED');
  }
  if (
    !requestRepository
    || typeof requestRepository.listByTenantId !== 'function'
    || typeof requestRepository.createForTenant !== 'function'
  ) {
    throw new TypeError('REQUEST_REPOSITORY_REQUIRED');
  }
  if (
    !authorizationPolicy
    || typeof authorizationPolicy.authorizeTenantApplicationRead !== 'function'
    || typeof authorizationPolicy.authorizeRequestCreate !== 'function'
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

    async getCatalog({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorizeRead(principal, tenantContext);
      return repository.loadCatalog(tenantContext.tenantId);
    },

    async getSiteInfo(args) {
      const catalog = await this.getCatalog(args);
      return Object.freeze({ sites: catalog.sites });
    },

    async listRequests({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      const scope = authorizationPolicy.requestListScope(principal, tenantContext);
      const requests = await requestRepository.listByTenantId(
        tenantContext.tenantId,
        { requesterUserId: scope.requesterUserId },
      );
      return Object.freeze(requests.map(publicRequest));
    },

    async createRequest({ principal, tenantContext, correlationId, requestDraft }) {
      requireCorrelationId(correlationId);
      authorizationPolicy.authorizeRequestCreate(principal, tenantContext);
      const draft = requireRequestDraft(requestDraft);
      await requireBookableRoom(tenantContext.tenantId, draft.roomId);
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
        newState: { status: 'Submitted' },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { operation: 'request_create' },
        retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
        occurredAt: createdAt.toISOString(),
      });
      const created = await requestRepository.createForTenant({
        tenantId: tenantContext.tenantId,
        requestId,
        requesterUserId: principal.userId,
        ...draft,
        createdAt,
        auditEvent,
      });
      if (!created) {
        throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      }
      return publicRequest(created);
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
      const catalog = await repository.loadCatalog(tenantContext.tenantId);
      return Object.freeze({ sites: catalog.sites });
    },
  });
}
