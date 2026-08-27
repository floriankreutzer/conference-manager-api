import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationInputError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeTenantLocations } from '../domain/tenant-locations.js';
import {
  assertTenantSettingsRevision,
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
  TENANT_SETTINGS_SCHEMA_VERSION,
} from './tenant-settings-revision.js';

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}
function now(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_LOCATIONS_CLOCK_INVALID');
  return new Date(value);
}
function auditEvent(auditService, {
  principal, tenantContext, correlationId, changedAt, previousRevision, nextRevision, locations,
}) {
  return auditService.createEvent({
    principal,
    tenantContext,
    correlationId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_configuration',
    targetId: 'locations',
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      operation: 'locations_update',
      siteCount: locations.sites.length,
      roomCount: locations.rooms.length,
    },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    occurredAt: changedAt.toISOString(),
  });
}

export function createTenantLocationsService({ repository, authorizationPolicy, auditService, clock = () => Date.now() } = {}) {
  if (!repository || typeof repository.get !== 'function' || typeof repository.update !== 'function') {
    throw new TypeError('TENANT_LOCATIONS_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createEvent !== 'function') throw new TypeError('AUDIT_SERVICE_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('TENANT_LOCATIONS_CLOCK_REQUIRED');
  function authorize(principal, tenantContext) {
    authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_CONFIGURE);
  }
  return Object.freeze({
    async get({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorize(principal, tenantContext);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_LOCATIONS_NOT_FOUND');
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...current });
    },
    async update({ principal, tenantContext, correlationId, payload }) {
      requireCorrelationId(correlationId);
      authorize(principal, tenantContext);
      requireTenantSettingsSchemaVersion(payload?.schemaVersion);
      const expectedRevision = requireTenantSettingsRevision(payload?.expectedRevision);
      const locations = normalizeTenantLocations(payload?.locations);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_LOCATIONS_NOT_FOUND');
      assertTenantSettingsRevision(expectedRevision, current.revision);
      const changedAt = now(clock);
      const result = await repository.update({
        tenantId: tenantContext.tenantId,
        expectedRevision,
        locations,
        changedAt,
        auditEvent: auditEvent(auditService, {
          principal,
          tenantContext,
          correlationId,
          changedAt,
          previousRevision: current.revision,
          nextRevision: nextTenantSettingsRevision(current.revision),
          locations,
        }),
      });
      if (result?.conflict) assertTenantSettingsRevision(expectedRevision, result.currentRevision);
      if (result?.invalidReference || result?.protectedReference || result?.unknownRoom) {
        throw new AuthorizationInputError('TENANT_LOCATIONS_REFERENCE_INVALID');
      }
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...result });
    },
  });
}
