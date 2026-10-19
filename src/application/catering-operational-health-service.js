import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { summarizeCateringOperationalHealth } from '../domain/catering-operational-health.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCateringConfiguration } from '../integrations/catering-configuration.js';
import { isTenantSessionAvailable } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { TenantSettingsInputError } from './tenant-settings-errors.js';

function invalid() { throw new TypeError('CATERING_HEALTH_RESULT_INVALID'); }
function uuid(value) {
  if (!isInternalUuid(value)) throw new TenantSettingsInputError('CATERING_HEALTH_IDENTIFIER_INVALID');
  return value.toLowerCase();
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}

export function createCateringOperationalHealthService({ repository, registry, authorizationPolicy, auditService,
  processingEnabled = false } = {}) {
  if (typeof processingEnabled !== 'boolean' || typeof repository?.load !== 'function' || typeof registry?.get !== 'function'
    || typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || typeof auditService?.recordAuthorizationDenied !== 'function') throw new TypeError('CATERING_HEALTH_PORT_REQUIRED');
  return Object.freeze({
    async current(context) {
      const correlationId = uuid(context?.correlationId); const integrationId = uuid(context?.integrationId);
      try {
        authorizationPolicy.requireTenantPermission(context?.principal, context?.tenantContext, PERMISSION.TENANT_INTEGRATIONS_MANAGE);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError && isInternalUuid(context?.principal?.tenantId)
          && context.principal.tenantId === context?.tenantContext?.tenantId) {
          await auditService.recordAuthorizationDenied({ principal: context.principal, tenantContext: context.tenantContext,
            correlationId, targetType: 'integration', targetId: 'catering-health', metadata: { operation: 'catering_health_read' } });
        }
        throw error;
      }
      if (!isTenantSessionAvailable(context.tenantContext)) throw new TenantUnavailableError();
      const tenantId = uuid(context.tenantContext.tenantId);
      const value = await repository.load({ tenantId, integrationId });
      if (value === null) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      record(value, ['tenantId','integrationId','providerId','configurationRevision','configuration','connectionAvailable',
        'tenantBusinessActive','observedAt','jobs']);
      if (value.tenantId !== tenantId || value.integrationId !== integrationId
        || !Number.isSafeInteger(value.configurationRevision) || value.configurationRevision < 1
        || value.configurationRevision >= Number.MAX_SAFE_INTEGER) invalid();
      let configuration; let descriptor;
      try {
        descriptor = registry.get(value.providerId);
        configuration = normalizeCateringConfiguration(value.configuration, descriptor);
      } catch { invalid(); }
      if (descriptor.id !== value.providerId) invalid();
      const summary = summarizeCateringOperationalHealth({ tenantId, integrationId,
        connectionAvailable: value.connectionAvailable, tenantBusinessActive: value.tenantBusinessActive,
        observedAt: value.observedAt, jobs: value.jobs, processingEnabled, modes: {
          initial: configuration.capabilities['catering.order'], change: configuration.capabilities['catering.update'],
          cancel: configuration.capabilities['catering.cancel'],
        } });
      return Object.freeze({ schemaVersion: 1, integrationId, providerId: descriptor.id,
        configurationRevision: value.configurationRevision, ...summary });
    },
  });
}
