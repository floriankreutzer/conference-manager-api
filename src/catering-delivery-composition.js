import { createCateringDeliveryService } from './application/catering-delivery-service.js';
import { cateringDeliveryEnabled } from './feature-flags.js';
import { createCateringDeliveryRouteModule } from './http/catering-delivery-jobs.js';
import { createCateringConfigurationRegistry } from './integrations/catering-provider-registration.js';
import { createPostgresCateringDeliveryRepository } from './persistence/postgres/catering-delivery-repository.js';

export function createCateringDeliveryRouteModules({ config, persistence, authorizationPolicy, auditService } = {}) {
  if (!cateringDeliveryEnabled(config?.featureFlags)) return Object.freeze([]);
  if (config?.demoRuntime) throw new TypeError('CATERING_DELIVERY_DEMO_NOT_SUPPORTED');
  if (!persistence?.pool || !auditService) throw new TypeError('CATERING_DELIVERY_PERSISTENCE_REQUIRED');
  const registry = createCateringConfigurationRegistry();
  const repository = createPostgresCateringDeliveryRepository(persistence.pool, { registry, auditRepository: persistence.auditRepository });
  const service = createCateringDeliveryService({ repository, authorizationPolicy, auditService });
  return Object.freeze([createCateringDeliveryRouteModule(service)]);
}
