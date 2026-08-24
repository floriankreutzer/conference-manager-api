import {
  createPostgresPool,
  isPostgresReady,
  isPostgresSchemaReady,
} from './pool.js';
import { createPostgresRequestRepository } from './request-repository.js';
import { createPostgresSessionRepository } from './session-repository.js';
import { createPostgresTenantRepository } from './tenant-repository.js';

export function createPostgresPersistence(config) {
  const pool = createPostgresPool(config);
  const tenantRepository = createPostgresTenantRepository(pool);
  const sessionRepository = createPostgresSessionRepository(pool);
  const requestRepository = createPostgresRequestRepository(pool);

  return Object.freeze({
    pool,
    sessionRepository,
    requestRepository,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    readinessChecks: [
      () => isPostgresReady(pool),
      () => isPostgresSchemaReady(pool),
    ],
    close: () => pool.end(),
  });
}
