import { createCateringVersionService } from './application/catering-version-service.js';
import { createCateringVersionRouteModule } from './http/catering-order-versions.js';
import { createPostgresCateringVersionRepository } from './persistence/postgres/catering-version-repository.js';
import { createCateringDeliveryService } from './application/catering-delivery-service.js';
import { createCateringManualDeliveryService } from './application/catering-manual-delivery-service.js';
import { cateringDeliveryEnabled } from './feature-flags.js';
import { createCateringDeliveryRouteModule } from './http/catering-delivery-jobs.js';
import { createCateringManualDeliveryRouteModule } from './http/catering-manual-delivery.js';
import { createCateringConfigurationRegistry } from './integrations/catering-provider-registration.js';
import { createPostgresCateringDeliveryRepository } from './persistence/postgres/catering-delivery-repository.js';
import { createPostgresCateringManualDeliveryRepository } from './persistence/postgres/catering-manual-delivery-repository.js';

export function createCateringDeliveryRouteModules({ config, persistence, authorizationPolicy, auditService } = {}) {
  if (!cateringDeliveryEnabled(config?.featureFlags)) return Object.freeze([]);
  if (config?.demoRuntime) throw new TypeError('CATERING_DELIVERY_DEMO_NOT_SUPPORTED');
  if (!persistence?.pool || !auditService) throw new TypeError('CATERING_DELIVERY_PERSISTENCE_REQUIRED');
  const registry = createCateringConfigurationRegistry();
  const repository = createPostgresCateringDeliveryRepository(persistence.pool, { registry, auditRepository: persistence.auditRepository });
  const service = createCateringDeliveryService({ repository, authorizationPolicy, auditService });
  const manualRepository = createPostgresCateringManualDeliveryRepository(persistence.pool,
    { registry, auditRepository: persistence.auditRepository });
  const manualService = createCateringManualDeliveryService({ repository: manualRepository, authorizationPolicy, auditService });
  const versions = createPostgresCateringVersionRepository(persistence.pool, { registry, auditRepository: persistence.auditRepository });
  const versionService = createCateringVersionService({ repository: versions, authorizationPolicy, auditService });
  return Object.freeze([createCateringDeliveryRouteModule(service), createCateringManualDeliveryRouteModule(manualService),
    createCateringVersionRouteModule(versionService)]);
}
