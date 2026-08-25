import { CalendarProviderError, PROVIDER_ERROR_KIND } from '../integrations/calendar-contract.js';
import { Microsoft365ProviderError } from '../integrations/microsoft365-client.js';

export const MICROSOFT365_CAPABILITY = Object.freeze({
  PLACES: 'places',
  FREE_BUSY: 'free_busy',
  CALENDAR_WRITE: 'calendar_write',
});

const CAPABILITIES = new Set(Object.values(MICROSOFT365_CAPABILITY));

function classify(error) {
  const code = error instanceof Microsoft365ProviderError ? error.code : null;
  const kind = error instanceof CalendarProviderError ? error.kind : null;
  if (code === 'MICROSOFT365_GRAPH_UNAUTHORIZED' || kind === PROVIDER_ERROR_KIND.AUTHORIZATION) {
    return { status: 'revoked', reason: 'provider_authorization_failed' };
  }
  if (code === 'MICROSOFT365_GRAPH_PERMISSION_MISSING') {
    return { status: 'permission_missing', reason: 'provider_permission_missing' };
  }
  if (code === 'MICROSOFT365_GRAPH_THROTTLED' || kind === PROVIDER_ERROR_KIND.THROTTLED) {
    return { status: 'degraded', reason: 'provider_throttled' };
  }
  if (
    code === 'MICROSOFT365_GRAPH_UNAVAILABLE'
    || code === 'MICROSOFT365_TOKEN_ACQUISITION_FAILED'
    || kind === PROVIDER_ERROR_KIND.UNAVAILABLE
    || kind === PROVIDER_ERROR_KIND.TIMEOUT
  ) {
    return { status: 'unavailable', reason: 'provider_unavailable' };
  }
  if (kind === PROVIDER_ERROR_KIND.NOT_FOUND) {
    return { status: 'degraded', reason: 'resource_mapping_invalid' };
  }
  return { status: 'degraded', reason: 'provider_operation_failed' };
}

function now(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('MICROSOFT365_HEALTH_CLOCK_INVALID');
  return new Date(value);
}

export function createMicrosoft365CapabilityHealthService({ repository, clock = () => Date.now() } = {}) {
  if (
    !repository
    || typeof repository.record !== 'function'
    || typeof repository.listByTenantIdAndIntegrationId !== 'function'
  ) {
    throw new TypeError('MICROSOFT365_HEALTH_REPOSITORY_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('MICROSOFT365_HEALTH_CLOCK_REQUIRED');

  function requireCapability(capability) {
    if (!CAPABILITIES.has(capability)) throw new TypeError('MICROSOFT365_HEALTH_CAPABILITY_INVALID');
  }

  return Object.freeze({
    list(tenantId, integrationId) {
      return repository.listByTenantIdAndIntegrationId(tenantId, integrationId);
    },

    recordSuccess({ tenantId, integrationId, capability }) {
      requireCapability(capability);
      return repository.record({
        tenantId,
        integrationId,
        capability,
        status: 'healthy',
        reason: null,
        checkedAt: now(clock),
        successful: true,
      });
    },

    recordFailure({ tenantId, integrationId, capability, error }) {
      requireCapability(capability);
      const failure = classify(error);
      return repository.record({
        tenantId,
        integrationId,
        capability,
        ...failure,
        checkedAt: now(clock),
        successful: false,
      });
    },
  });
}
