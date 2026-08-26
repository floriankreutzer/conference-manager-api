import { isInternalUuid } from '../domain/identifiers.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
} from '../integrations/calendar-contract.js';
import {
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
} from './microsoft365-connection-errors.js';

const VERIFICATION_OFFSET_MS = 5 * 60 * 1_000;
const VERIFICATION_WINDOW_MS = 30 * 60 * 1_000;

function mappedProviderError(error) {
  if (!(error instanceof CalendarProviderError)) return error;
  if (
    error.kind === PROVIDER_ERROR_KIND.AUTHORIZATION
    || error.kind === PROVIDER_ERROR_KIND.NOT_FOUND
    || error.kind === PROVIDER_ERROR_KIND.VALIDATION
  ) {
    return new Microsoft365ConnectionConflictError('MICROSOFT365_FREE_BUSY_VERIFICATION_BLOCKED');
  }
  return new Microsoft365ConnectionUnavailableError('MICROSOFT365_FREE_BUSY_VERIFICATION_UNAVAILABLE');
}

export function createMicrosoft365OnboardingVerificationService({
  roomMappingService,
  calendarProviderFactory,
  clock = () => Date.now(),
} = {}) {
  if (!roomMappingService || typeof roomMappingService.listMappings !== 'function') {
    throw new TypeError('MICROSOFT365_ROOM_MAPPING_SERVICE_REQUIRED');
  }
  if (!calendarProviderFactory || typeof calendarProviderFactory.forRoom !== 'function') {
    throw new TypeError('MICROSOFT365_CALENDAR_PROVIDER_FACTORY_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('MICROSOFT365_VERIFICATION_CLOCK_REQUIRED');

  return Object.freeze({
    async verifyFreeBusy({ principal, tenantContext, correlationId }) {
      if (!isInternalUuid(correlationId)) {
        throw new Microsoft365ConnectionInputError('MICROSOFT365_CORRELATION_INVALID');
      }
      const mappings = await roomMappingService.listMappings({
        principal,
        tenantContext,
        correlationId,
      });
      const mapping = mappings.find((candidate) => candidate.providerStatus === 'active');
      if (!mapping) {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_ROOM_MAPPING_REQUIRED');
      }
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Microsoft365ConnectionInputError('MICROSOFT365_CLOCK_INVALID');
      }
      const checkedAt = new Date(now).toISOString();
      const startsAt = new Date(now + VERIFICATION_OFFSET_MS).toISOString();
      const endsAt = new Date(now + VERIFICATION_OFFSET_MS + VERIFICATION_WINDOW_MS).toISOString();
      try {
        const provider = await calendarProviderFactory.forRoom({
          tenantId: tenantContext.tenantId,
          roomId: mapping.roomId,
        });
        await provider.lookupAvailability(Object.freeze({
          tenantId: tenantContext.tenantId,
          roomId: mapping.roomId,
          startsAt,
          endsAt,
        }));
        return Object.freeze({ verified: true, checkedAt });
      } catch (error) {
        throw mappedProviderError(error);
      }
    },
  });
}
