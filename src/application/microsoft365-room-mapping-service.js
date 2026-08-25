import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
} from './microsoft365-connection-errors.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_NAME_MAX = 160;
const IMPORT_LIMIT = 100;

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new Microsoft365ConnectionInputError('MICROSOFT365_CORRELATION_INVALID');
}

function changedAt(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_CLOCK_INVALID');
  }
  return new Date(value);
}

function normalizedLocalName(value, providerName) {
  const candidate = value === undefined ? providerName : value;
  if (typeof candidate !== 'string') {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_NAME_INVALID');
  }
  const normalized = candidate.trim();
  if (
    normalized.length < 1
    || normalized.length > LOCAL_NAME_MAX
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_NAME_INVALID');
  }
  return normalized;
}

function normalizedLocalCapacity(value, providerCapacity) {
  const candidate = value === undefined ? providerCapacity : value;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 100_000) {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_CAPACITY_REQUIRED');
  }
  return candidate;
}

function validateSelections(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > IMPORT_LIMIT) {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SELECTION_INVALID');
  }
  const externalIds = new Set();
  for (const selection of value) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SELECTION_INVALID');
    }
    const keys = Object.keys(selection);
    const allowed = new Set(['externalRoomId', 'siteId', 'name', 'capacity']);
    if (keys.some((key) => !allowed.has(key))) {
      throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SELECTION_INVALID');
    }
    if (
      typeof selection.externalRoomId !== 'string'
      || selection.externalRoomId.length < 1
      || selection.externalRoomId.length > 512
      || /[\u0000-\u001f\u007f]/.test(selection.externalRoomId)
      || typeof selection.siteId !== 'string'
      || !ID_PATTERN.test(selection.siteId)
    ) {
      throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SELECTION_INVALID');
    }
    if (externalIds.has(selection.externalRoomId)) {
      throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SELECTION_DUPLICATE');
    }
    externalIds.add(selection.externalRoomId);
    if (selection.name !== undefined && typeof selection.name !== 'string') {
      throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SELECTION_INVALID');
    }
    if (selection.capacity !== undefined && !Number.isSafeInteger(selection.capacity)) {
      throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SELECTION_INVALID');
    }
  }
  return value;
}

function publicMapping(mapping) {
  return Object.freeze({
    roomId: mapping.roomId,
    externalRoomId: mapping.externalRoomId,
    resourceAddress: mapping.resourceAddress,
    providerDisplayName: mapping.providerDisplayName,
    providerCapacity: mapping.providerCapacity,
    providerStatus: mapping.providerStatus,
    lastSeenAt: mapping.lastSeenAt,
    localRoom: mapping.localRoom,
  });
}

export function createMicrosoft365RoomMappingService({
  mappingRepository,
  connectionRepository,
  discoveryService,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !mappingRepository
    || typeof mappingRepository.listByTenantIdAndIntegrationId !== 'function'
    || typeof mappingRepository.existingSiteIds !== 'function'
    || typeof mappingRepository.importRooms !== 'function'
    || typeof mappingRepository.synchronize !== 'function'
  ) {
    throw new TypeError('MICROSOFT365_ROOM_MAPPING_REPOSITORY_REQUIRED');
  }
  if (!connectionRepository || typeof connectionRepository.findByTenantId !== 'function') {
    throw new TypeError('MICROSOFT365_CONNECTION_REPOSITORY_REQUIRED');
  }
  if (!discoveryService || typeof discoveryService.discoverRooms !== 'function') {
    throw new TypeError('MICROSOFT365_ROOM_DISCOVERY_SERVICE_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function' || typeof idFactory !== 'function') {
    throw new TypeError('MICROSOFT365_ROOM_MAPPING_RUNTIME_INVALID');
  }

  async function authorize({ principal, tenantContext, correlationId, operation }) {
    try {
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_CONFIGURE,
      );
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_INTEGRATIONS_MANAGE,
      );
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        await auditService.recordAuthorizationDenied({
          principal,
          tenantContext,
          correlationId,
          targetType: 'room_mapping',
          targetId: 'microsoft365',
          metadata: { operation },
        });
      }
      throw error;
    }
  }

  async function connectionFor(tenantContext) {
    const connection = await connectionRepository.findByTenantId(tenantContext.tenantId);
    if (
      !connection
      || !isInternalUuid(connection.integrationId)
      || !['connected', 'degraded'].includes(connection.status)
      || connection.placesPermission !== 'granted'
    ) {
      throw new Microsoft365ConnectionConflictError('MICROSOFT365_CONNECTION_REQUIRED');
    }
    return connection;
  }

  function auditEventFor({ principal, tenantContext, correlationId, occurredAt }) {
    return ({ roomId, operation, providerStatus }) => auditService.createEvent({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
      targetType: 'room',
      targetId: roomId,
      previousState: null,
      newState: { providerStatus },
      outcome: AUDIT_OUTCOME.SUCCESS,
      metadata: { operation },
      retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
      occurredAt,
    });
  }

  async function discoveredProviderRooms({ principal, tenantContext, correlationId }) {
    const rooms = await discoveryService.discoverRooms({ principal, tenantContext, correlationId });
    return rooms.map((room) => Object.freeze({
      externalRoomId: room.externalRoomId,
      resourceAddress: room.resourceAddress,
      providerDisplayName: room.displayName,
      providerCapacity: room.capacity,
    }));
  }

  return Object.freeze({
    async listMappings({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'room_mapping_list' });
      const connection = await connectionFor(tenantContext);
      const mappings = await mappingRepository.listByTenantIdAndIntegrationId(
        tenantContext.tenantId,
        connection.integrationId,
      );
      return Object.freeze(mappings.map(publicMapping));
    },

    async importSelectedRooms({ principal, tenantContext, correlationId, selections }) {
      requireCorrelationId(correlationId);
      const selected = validateSelections(selections);
      await authorize({ principal, tenantContext, correlationId, operation: 'room_import' });
      const connection = await connectionFor(tenantContext);
      const discovered = await discoveredProviderRooms({ principal, tenantContext, correlationId });
      const discoveredById = new Map(discovered.map((room) => [room.externalRoomId, room]));

      const siteIds = [...new Set(selected.map((selection) => selection.siteId))];
      const existingSiteIds = await mappingRepository.existingSiteIds(tenantContext.tenantId, siteIds);
      if (siteIds.some((siteId) => !existingSiteIds.has(siteId))) {
        throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_SITE_INVALID');
      }

      const imports = selected.map((selection) => {
        const providerRoom = discoveredById.get(selection.externalRoomId);
        if (!providerRoom) {
          throw new Microsoft365ConnectionConflictError('MICROSOFT365_ROOM_NOT_DISCOVERED');
        }
        const roomId = idFactory();
        if (!isInternalUuid(roomId)) {
          throw new Microsoft365ConnectionInputError('MICROSOFT365_ROOM_IDENTIFIER_INVALID');
        }
        return Object.freeze({
          roomId,
          siteId: selection.siteId,
          localName: normalizedLocalName(selection.name, providerRoom.providerDisplayName),
          localCapacity: normalizedLocalCapacity(selection.capacity, providerRoom.providerCapacity),
          ...providerRoom,
        });
      });
      const at = changedAt(clock);
      const result = await mappingRepository.importRooms({
        tenantId: tenantContext.tenantId,
        integrationId: connection.integrationId,
        rooms: imports,
        changedAt: at,
        auditEventFor: auditEventFor({
          principal,
          tenantContext,
          correlationId,
          occurredAt: at.toISOString(),
        }),
      });
      if (result?.status === 'conflict') {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_ROOM_MAPPING_CONFLICT');
      }
      if (!Array.isArray(result)) throw new Microsoft365ConnectionUnavailableError();
      return Object.freeze(result.map(publicMapping));
    },

    async synchronize({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'room_sync' });
      const connection = await connectionFor(tenantContext);
      const discovered = await discoveredProviderRooms({ principal, tenantContext, correlationId });
      const at = changedAt(clock);
      const result = await mappingRepository.synchronize({
        tenantId: tenantContext.tenantId,
        integrationId: connection.integrationId,
        discoveredRooms: discovered,
        changedAt: at,
        auditEventFor: auditEventFor({
          principal,
          tenantContext,
          correlationId,
          occurredAt: at.toISOString(),
        }),
      });
      if (result?.status === 'conflict') {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_ROOM_MAPPING_CONFLICT');
      }
      if (!Array.isArray(result)) throw new Microsoft365ConnectionUnavailableError();
      return Object.freeze(result.map(publicMapping));
    },
  });
}
