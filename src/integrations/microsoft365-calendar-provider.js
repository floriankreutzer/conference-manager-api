import { isInternalUuid } from '../domain/identifiers.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
} from './calendar-contract.js';
import { Microsoft365ProviderError } from './microsoft365-client.js';

const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertTenantRoomInput(input, tenantId, roomId, operation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CalendarProviderError(PROVIDER_ERROR_KIND.VALIDATION, { operation });
  }
  if (input.tenantId !== tenantId || input.roomId !== roomId) {
    throw new CalendarProviderError(PROVIDER_ERROR_KIND.AUTHORIZATION, { operation });
  }
}

function mapProviderError(error, operation) {
  if (error instanceof CalendarProviderError) return error;
  if (!(error instanceof Microsoft365ProviderError)) {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.UNKNOWN, { operation });
  }
  if (error.code === 'MICROSOFT365_GRAPH_THROTTLED') {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.THROTTLED, { operation });
  }
  if (
    error.code === 'MICROSOFT365_GRAPH_UNAVAILABLE'
    || error.code === 'MICROSOFT365_TOKEN_ACQUISITION_FAILED'
  ) {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.UNAVAILABLE, { operation });
  }
  if (
    error.code === 'MICROSOFT365_GRAPH_UNAUTHORIZED'
    || error.code === 'MICROSOFT365_GRAPH_PERMISSION_MISSING'
    || error.code === 'MICROSOFT365_TOKEN_INVALID'
  ) {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.AUTHORIZATION, { operation });
  }
  if (error.code === 'MICROSOFT365_CALENDAR_CONFLICT') {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.CONFLICT, { operation });
  }
  if (error.code === 'MICROSOFT365_CALENDAR_NOT_FOUND') {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.NOT_FOUND, { operation });
  }
  if (
    error.code === 'MICROSOFT365_FREE_BUSY_RESPONSE_INVALID'
    || error.code === 'MICROSOFT365_CALENDAR_WRITE_RESPONSE_INVALID'
    || error.code === 'MICROSOFT365_RESPONSE_TOO_LARGE'
    || error.code === 'MICROSOFT365_RESPONSE_INVALID'
  ) {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.MALFORMED_RESPONSE, { operation });
  }
  if (
    error.code === 'MICROSOFT365_GRAPH_REQUEST_INVALID'
    || error.code === 'MICROSOFT365_CALENDAR_REFERENCE_INVALID'
    || error.code === 'MICROSOFT365_CALENDAR_IDEMPOTENCY_INVALID'
    || error.code === 'MICROSOFT365_FREE_BUSY_REQUEST_INVALID'
  ) {
    return new CalendarProviderError(PROVIDER_ERROR_KIND.VALIDATION, { operation });
  }
  return new CalendarProviderError(PROVIDER_ERROR_KIND.UNKNOWN, { operation });
}

function requireWriteMethod(providerClient, method, operation) {
  if (typeof providerClient[method] !== 'function') {
    throw new CalendarProviderError(PROVIDER_ERROR_KIND.VALIDATION, { operation });
  }
  return providerClient[method].bind(providerClient);
}

function createBoundProvider({
  tenantId,
  integrationId,
  providerTenantReference,
  roomId,
  resourceAddress,
  providerClient,
}) {
  async function availability(input, operation) {
    assertTenantRoomInput(input, tenantId, roomId, operation);
    try {
      const result = await providerClient.lookupFreeBusy({
        tenantReference: providerTenantReference,
        schedules: [resourceAddress],
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      });
      if (!Array.isArray(result) || result.length !== 1 || result[0]?.schedule !== resourceAddress) {
        throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_RESPONSE_INVALID');
      }
      return result[0];
    } catch (error) {
      throw mapProviderError(error, operation);
    }
  }

  async function write(operation, input, method, values) {
    assertTenantRoomInput(input, tenantId, roomId, operation);
    try {
      const invoke = requireWriteMethod(providerClient, method, operation);
      return await invoke(values);
    } catch (error) {
      throw mapProviderError(error, operation);
    }
  }

  return Object.freeze({
    integrationId,
    lookupAvailability(input) {
      return availability(input, 'availability');
    },
    async validateReservation(input) {
      const result = await availability(input, 'reservation_validation');
      return Object.freeze({
        valid: result.available,
        reason: result.available ? 'available' : 'conflict',
      });
    },
    createCalendarEvent(input) {
      return write('create', input, 'createCalendarEvent', {
        tenantReference: providerTenantReference,
        resourceAddress,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        idempotencyKey: input.idempotencyKey,
      });
    },
    updateCalendarEvent(input) {
      return write('update', input, 'updateCalendarEvent', {
        tenantReference: providerTenantReference,
        resourceAddress,
        providerReference: input.providerReference,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      });
    },
    cancelCalendarEvent(input) {
      return write('cancel', input, 'cancelCalendarEvent', {
        tenantReference: providerTenantReference,
        resourceAddress,
        providerReference: input.providerReference,
      });
    },
  });
}

export function createMicrosoft365CalendarProviderFactory({
  connectionRepository,
  mappingRepository,
  providerClient,
} = {}) {
  if (!connectionRepository || typeof connectionRepository.findByTenantId !== 'function') {
    throw new TypeError('MICROSOFT365_CONNECTION_REPOSITORY_REQUIRED');
  }
  if (!mappingRepository || typeof mappingRepository.listByTenantIdAndIntegrationId !== 'function') {
    throw new TypeError('MICROSOFT365_ROOM_MAPPING_REPOSITORY_REQUIRED');
  }
  if (!providerClient || typeof providerClient.lookupFreeBusy !== 'function') {
    throw new TypeError('MICROSOFT365_FREE_BUSY_CLIENT_REQUIRED');
  }

  return Object.freeze({
    async forRoom({ tenantId, roomId } = {}) {
      if (!isInternalUuid(tenantId)) throw new TypeError('TENANT_ID_INVALID');
      if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
        throw new TypeError('ROOM_ID_INVALID');
      }
      const connection = await connectionRepository.findByTenantId(tenantId);
      if (
        !connection
        || connection.status !== 'connected'
        || connection.calendarsPermission !== 'granted'
      ) {
        throw new CalendarProviderError(PROVIDER_ERROR_KIND.AUTHORIZATION, { operation: 'availability' });
      }
      const mappings = await mappingRepository.listByTenantIdAndIntegrationId(
        tenantId,
        connection.integrationId,
      );
      const mapping = mappings.find((candidate) => candidate.roomId === roomId);
      if (!mapping || mapping.providerStatus !== 'active') {
        throw new CalendarProviderError(PROVIDER_ERROR_KIND.NOT_FOUND, { operation: 'availability' });
      }
      return createBoundProvider({
        tenantId,
        integrationId: connection.integrationId,
        providerTenantReference: connection.providerTenantReference,
        roomId,
        resourceAddress: mapping.resourceAddress,
        providerClient,
      });
    },
  });
}
