import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
} from '../integrations/calendar-contract.js';

const VERIFICATION_WINDOW_MS = 30 * 60 * 1_000;

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new TypeError('MICROSOFT365_CORRELATION_INVALID');
}

function verificationWindow(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('MICROSOFT365_CLOCK_INVALID');
  const startsAt = new Date(value + 60_000);
  const endsAt = new Date(startsAt.getTime() + VERIFICATION_WINDOW_MS);
  return Object.freeze({
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    checkedAt: new Date(value).toISOString(),
  });
}

export function createMicrosoft365AvailabilityVerificationService({
  mappingRepository,
  connectionRepository,
  calendarProviderFactory,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  if (!mappingRepository || typeof mappingRepository.listByTenantIdAndIntegrationId !== 'function') {
    throw new TypeError('MICROSOFT365_ROOM_MAPPING_REPOSITORY_REQUIRED');
  }
  if (!connectionRepository || typeof connectionRepository.findByTenantId !== 'function') {
    throw new TypeError('MICROSOFT365_CONNECTION_REPOSITORY_REQUIRED');
  }
  if (!calendarProviderFactory || typeof calendarProviderFactory.forRoom !== 'function') {
    throw new TypeError('MICROSOFT365_CALENDAR_PROVIDER_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.recordAuthorizationDenied !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('MICROSOFT365_CLOCK_REQUIRED');

  async function authorize({ principal, tenantContext, correlationId }) {
    try {
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
          targetType: 'integration',
          targetId: 'microsoft365',
          metadata: { operation: 'free_busy_verification' },
        });
      }
      throw error;
    }
  }

  return Object.freeze({
    async verify({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId });
      const connection = await connectionRepository.findByTenantId(tenantContext.tenantId);
      if (!connection || !isInternalUuid(connection.integrationId) || connection.status !== 'connected') {
        throw new CalendarProviderError(
          PROVIDER_ERROR_KIND.AUTHORIZATION,
          { operation: 'availability_verification' },
        );
      }
      const mappings = await mappingRepository.listByTenantIdAndIntegrationId(
        tenantContext.tenantId,
        connection.integrationId,
      );
      const mapping = mappings.find((candidate) => candidate.providerStatus === 'active');
      if (!mapping) {
        throw new CalendarProviderError(
          PROVIDER_ERROR_KIND.NOT_FOUND,
          { operation: 'availability_verification' },
        );
      }

      const window = verificationWindow(clock);
      const provider = await calendarProviderFactory.forRoom({
        tenantId: tenantContext.tenantId,
        roomId: mapping.roomId,
      });
      await provider.lookupAvailability({
        tenantId: tenantContext.tenantId,
        roomId: mapping.roomId,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
      });
      return Object.freeze({ verified: true, checkedAt: window.checkedAt });
    },
  });
}
