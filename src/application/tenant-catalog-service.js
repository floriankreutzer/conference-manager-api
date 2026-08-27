import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationInputError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeTenantCatalog } from '../domain/tenant-catalog.js';
import {
  assertTenantSettingsRevision,
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
  TENANT_SETTINGS_SCHEMA_VERSION,
} from './tenant-settings-revision.js';

function correlation(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}
function instant(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_CATALOG_CLOCK_INVALID');
  return new Date(value);
}
export function createTenantCatalogService({ repository, authorizationPolicy, auditService, clock = () => Date.now() } = {}) {
  if (!repository || typeof repository.get !== 'function' || typeof repository.update !== 'function') throw new TypeError('TENANT_CATALOG_REPOSITORY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  if (!auditService || typeof auditService.createEvent !== 'function') throw new TypeError('AUDIT_SERVICE_REQUIRED');
  function authorize(principal, tenantContext) {
    authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_CONFIGURE);
  }
  return Object.freeze({
    async get({ principal, tenantContext, correlationId }) {
      correlation(correlationId); authorize(principal, tenantContext);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_CATALOG_NOT_FOUND');
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...current });
    },
    async update({ principal, tenantContext, correlationId, payload }) {
      correlation(correlationId); authorize(principal, tenantContext);
      requireTenantSettingsSchemaVersion(payload?.schemaVersion);
      const expectedRevision = requireTenantSettingsRevision(payload?.expectedRevision);
      const catalog = normalizeTenantCatalog(payload?.catalog);
      const current = await repository.get(tenantContext.tenantId);
      if (!current) throw new AuthorizationInputError('TENANT_CATALOG_NOT_FOUND');
      assertTenantSettingsRevision(expectedRevision, current.revision);
      const changedAt = instant(clock);
      const result = await repository.update({
        tenantId: tenantContext.tenantId,
        expectedRevision,
        catalog,
        changedAt,
        auditEvent: auditService.createEvent({
          principal,
          tenantContext,
          correlationId,
          action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
          targetType: 'tenant_configuration',
          targetId: 'catalog',
          previousState: { revision: current.revision },
          newState: { revision: nextTenantSettingsRevision(current.revision) },
          outcome: AUDIT_OUTCOME.SUCCESS,
          metadata: {
            operation: 'catalog_update',
            serviceCount: catalog.services.length,
            packageCount: catalog.cateringPackages.length,
            itemCount: catalog.cateringItems.length,
          },
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
          occurredAt: changedAt.toISOString(),
        }),
      });
      if (result?.conflict) assertTenantSettingsRevision(expectedRevision, result.currentRevision);
      if (result?.protectedReference) throw new AuthorizationInputError('TENANT_CATALOG_REFERENCE_PROTECTED');
      return Object.freeze({ schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION, ...result });
    },
  });
}
