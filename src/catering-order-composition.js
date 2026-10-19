import { createCateringOrderService } from './application/catering-order-service.js';
import { cateringOrdersEnabled } from './feature-flags.js';
import { createCateringOrderRouteModule } from './http/catering-orders.js';
import { createCateringConfigurationRegistry } from './integrations/catering-provider-registration.js';
import { createPostgresCateringOrderRepository } from './persistence/postgres/catering-order-repository.js';

export function createCateringOrderRouteModules({ config, persistence, authorizationPolicy, auditService } = {}) {
  if (!cateringOrdersEnabled(config?.featureFlags)) return Object.freeze([]);
  if (config?.demoRuntime) throw new TypeError('CATERING_ORDER_DEMO_NOT_SUPPORTED');
  if (!persistence?.pool || !auditService) throw new TypeError('CATERING_ORDER_PERSISTENCE_REQUIRED');
  const registry = createCateringConfigurationRegistry();
  const repository = createPostgresCateringOrderRepository(persistence.pool, { registry, auditRepository: persistence.auditRepository });
  const service = createCateringOrderService({ repository, registry, authorizationPolicy, auditService });
  return Object.freeze([createCateringOrderRouteModule(service)]);
}
