import { createCateringConfigurationService } from './application/catering-configuration-service.js';
import { cateringConfigurationEnabled } from './feature-flags.js';
import { defineRouteModule } from './http/route-module.js';
import {
  cateringConfigurationRouteKey, createCateringConfigurationHttpHandler,
} from './http/settings/catering-integrations.js';
import { createCateringConfigurationRegistry } from './integrations/catering-provider-registration.js';
import { createPostgresCateringConfigurationRepository } from './persistence/postgres/catering-configuration-repository.js';

export function createCateringConfigurationRouteModules({ config, persistence, authorizationPolicy, auditService } = {}) {
  if (!cateringConfigurationEnabled(config?.featureFlags)) return Object.freeze([]);
  if (config?.demoRuntime) throw new TypeError('CATERING_CONFIGURATION_DEMO_NOT_SUPPORTED');
  if (!persistence?.pool || !auditService) throw new TypeError('CATERING_CONFIGURATION_PERSISTENCE_REQUIRED');
  const registry = createCateringConfigurationRegistry();
  const repository = createPostgresCateringConfigurationRepository(persistence.pool, {
    registry, auditRepository: persistence.auditRepository,
  });
  const service = createCateringConfigurationService({ repository, registry, authorizationPolicy, auditService });
  return Object.freeze([defineRouteModule({
    id: 'catering-configuration', routeKey: cateringConfigurationRouteKey,
    createHandler(runtime) {
      return createCateringConfigurationHttpHandler({
        service, principalGuard: runtime?.principalGuard, tenantGuard: runtime?.tenantGuard,
        maxBodyBytes: runtime?.maxBodyBytes, maxResponseBytes: runtime?.maxResponseBytes,
      });
    },
  })]);
}
