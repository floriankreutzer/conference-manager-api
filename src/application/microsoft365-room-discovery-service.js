import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { ENTRA_IDENTITY_PROVIDER } from '../identity/entra-client.js';
import { Microsoft365ProviderError } from '../integrations/microsoft365-client.js';
import { executeSafeProviderOperation } from '../integrations/provider-retry.js';
import { MICROSOFT365_CAPABILITY } from './microsoft365-capability-health-service.js';
import {
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
} from './microsoft365-connection-errors.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new Microsoft365ConnectionInputError('MICROSOFT365_CORRELATION_INVALID');
}

function requireProviderTenant(value) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
    throw new Microsoft365ConnectionConflictError('MICROSOFT365_PROVIDER_TENANT_MISMATCH');
  }
  return value.toLowerCase();
}

function providerFailure(error) {
  if (!(error instanceof Microsoft365ProviderError)) return null;
  if (error.code === 'MICROSOFT365_GRAPH_UNAUTHORIZED') {
    return new Microsoft365ConnectionConflictError('MICROSOFT365_CONNECTION_REVOKED');
  }
  if (error.code === 'MICROSOFT365_GRAPH_PERMISSION_MISSING') {
    return new Microsoft365ConnectionConflictError('MICROSOFT365_PLACES_PERMISSION_MISSING');
  }
  if (error.code === 'MICROSOFT365_GRAPH_THROTTLED') {
    return new Microsoft365ConnectionUnavailableError('MICROSOFT365_GRAPH_THROTTLED');
  }
  return new Microsoft365ConnectionUnavailableError('MICROSOFT365_ROOM_DISCOVERY_UNAVAILABLE');
}

function retryClassification(error) {
  if (!(error instanceof Microsoft365ProviderError)) return { retryable: false, retryAfterMs: null };
  return {
    retryable: [
      'MICROSOFT365_GRAPH_THROTTLED',
      'MICROSOFT365_GRAPH_UNAVAILABLE',
      'MICROSOFT365_TOKEN_ACQUISITION_FAILED',
    ].includes(error.code),
    retryAfterMs: null,
  };
}

export function createMicrosoft365RoomDiscoveryService({
  connectionRepository,
  bindingRepository,
  authorizationPolicy,
  auditService,
  providerClient,
  capabilityHealthService = null,
  retrySleep,
} = {}) {
  if (!connectionRepository || typeof connectionRepository.findByTenantId !== 'function') {
    throw new TypeError('MICROSOFT365_CONNECTION_REPOSITORY_REQUIRED');
  }
  if (!bindingRepository || typeof bindingRepository.findActiveBindingByTenantId !== 'function') {
    throw new TypeError('TENANT_BINDING_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.recordAuthorizationDenied !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (!providerClient || typeof providerClient.discoverRooms !== 'function') {
    throw new TypeError('MICROSOFT365_PROVIDER_CLIENT_REQUIRED');
  }
  if (
    capabilityHealthService
    && (
      typeof capabilityHealthService.recordSuccess !== 'function'
      || typeof capabilityHealthService.recordFailure !== 'function'
    )
  ) {
    throw new TypeError('MICROSOFT365_HEALTH_SERVICE_INVALID');
  }
  if (retrySleep !== undefined && typeof retrySleep !== 'function') {
    throw new TypeError('MICROSOFT365_RETRY_SLEEP_INVALID');
  }

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
          metadata: { operation: 'room_discovery' },
        });
      }
      throw error;
    }
  }

  return Object.freeze({
    async discoverRooms({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId });

      const [connection, binding] = await Promise.all([
        connectionRepository.findByTenantId(tenantContext.tenantId),
        bindingRepository.findActiveBindingByTenantId(
          tenantContext.tenantId,
          ENTRA_IDENTITY_PROVIDER,
        ),
      ]);
      if (!connection || !binding) {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_CONNECTION_REQUIRED');
      }
      if (connection.status === 'disconnected' || connection.status === 'pending' || connection.status === 'revoked') {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_CONNECTION_REQUIRED');
      }
      if (connection.placesPermission !== 'granted') {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_PLACES_PERMISSION_MISSING');
      }

      const connectionTenant = requireProviderTenant(connection.providerTenantReference);
      const bindingTenant = requireProviderTenant(binding.providerTenantReference);
      if (connectionTenant !== bindingTenant) {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_PROVIDER_TENANT_MISMATCH');
      }

      try {
        const rooms = await executeSafeProviderOperation(
          () => providerClient.discoverRooms({ tenantReference: bindingTenant }),
          {
            classifyError: retryClassification,
            ...(retrySleep ? { sleep: retrySleep } : {}),
          },
        );
        await capabilityHealthService?.recordSuccess({
          tenantId: tenantContext.tenantId,
          integrationId: connection.integrationId,
          capability: MICROSOFT365_CAPABILITY.PLACES,
        });
        return rooms;
      } catch (error) {
        await capabilityHealthService?.recordFailure({
          tenantId: tenantContext.tenantId,
          integrationId: connection.integrationId,
          capability: MICROSOFT365_CAPABILITY.PLACES,
          error,
        });
        const mapped = providerFailure(error);
        if (mapped) throw mapped;
        throw error;
      }
    },
  });
}
