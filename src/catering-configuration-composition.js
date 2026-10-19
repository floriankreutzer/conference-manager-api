import { createCateringCataloguePublicationService } from './application/catering-catalogue-publication-service.js';
import { createCateringCataloguePublicationReadService } from './application/catering-catalogue-publication-read-service.js';
import { createCateringCataloguePublicationRouteModule } from './http/catering-catalogue-publication.js';
import { createPostgresCateringCataloguePublicationRepository
} from './persistence/postgres/catering-catalogue-publication-repository.js';
import { createPostgresCateringCataloguePublicationReadRepository
} from './persistence/postgres/catering-catalogue-publication-read-repository.js';
import { createCateringProviderCatalogueService } from './application/catering-provider-catalogue-service.js';
import { createCateringProviderCatalogueRouteModule } from './http/catering-provider-catalogues.js';
import { createPostgresCateringProviderCatalogueRepository } from './persistence/postgres/catering-provider-catalogue-repository.js';
import { createCateringCatalogueAssignmentService } from './application/catering-catalogue-assignment-service.js';
import { createCateringCatalogueAssignmentRouteModule } from './http/catering-catalogue-assignments.js';
import {
  createPostgresCateringCatalogueAssignmentRepository,
} from './persistence/postgres/catering-catalogue-assignment-repository.js';
import { createCateringConfigurationService } from './application/catering-configuration-service.js';
import { createCateringOperationalHealthService } from './application/catering-operational-health-service.js';
import { createCateringOperationalHealthRouteModule } from './http/settings/catering-health.js';
import { createPostgresCateringOperationalHealthRepository } from './persistence/postgres/catering-operational-health-repository.js';
import { cateringConfigurationEnabled, cateringDeliveryEnabled } from './feature-flags.js';
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
  const assignmentRepository = createPostgresCateringCatalogueAssignmentRepository(persistence.pool, {
    registry, auditRepository: persistence.auditRepository,
  });
  const assignmentService = createCateringCatalogueAssignmentService({ repository: assignmentRepository,
    authorizationPolicy, auditService });
  const healthService = createCateringOperationalHealthService({ registry, authorizationPolicy, auditService,
    processingEnabled: cateringDeliveryEnabled(config?.featureFlags),
    repository: createPostgresCateringOperationalHealthRepository(persistence.pool, { registry }) });
  const providerCatalogueService = createCateringProviderCatalogueService({ registry, authorizationPolicy, auditService,
    maxResponseBytes: config.maxResponseBytes, repository: createPostgresCateringProviderCatalogueRepository(persistence.pool,
      { registry, auditRepository: persistence.auditRepository }) });
  const publicationService = createCateringCataloguePublicationService({ authorizationPolicy,auditService,
    repository: createPostgresCateringCataloguePublicationRepository(persistence.pool,
      { registry,auditRepository: persistence.auditRepository }) });
  const publicationReadService = createCateringCataloguePublicationReadService({ registry,authorizationPolicy,auditService,
    maxResponseBytes: config.maxResponseBytes,
    repository: createPostgresCateringCataloguePublicationReadRepository(persistence.pool,{ registry }) });
  return Object.freeze([defineRouteModule({
    id: 'catering-configuration', routeKey: cateringConfigurationRouteKey,
    createHandler(runtime) {
      return createCateringConfigurationHttpHandler({
        service, principalGuard: runtime?.principalGuard, tenantGuard: runtime?.tenantGuard,
        maxBodyBytes: runtime?.maxBodyBytes, maxResponseBytes: runtime?.maxResponseBytes,
      });
    },
  }), createCateringCatalogueAssignmentRouteModule(assignmentService), createCateringOperationalHealthRouteModule(healthService),
  createCateringProviderCatalogueRouteModule(providerCatalogueService),
  createCateringCataloguePublicationRouteModule(publicationService,publicationReadService)]);
}
