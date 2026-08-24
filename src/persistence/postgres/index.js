import {
  createPostgresPool,
  isPostgresReady,
  isPostgresSchemaReady,
} from './pool.js';
import { createPostgresSessionRepository } from './session-repository.js';
import { createPostgresTenantRepository } from './tenant-repository.js';

export function createPostgresPersistence(config) {
  const pool = createPostgresPool(config);
  const tenantRepository = createPostgresTenantRepository(pool);
  const sessionRepository = createPostgresSessionRepository(pool);

  return Object.freeze({
    pool,
    sessionRepository,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    readinessChecks: [
      () => isPostgresReady(pool),
      () => isPostgresSchemaReady(pool),
    ],
    close: () => pool.end(),
  });
}
