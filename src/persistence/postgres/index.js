import {
  createPostgresPool,
  isPostgresReady,
  isPostgresSchemaReady,
} from './pool.js';
import { createPostgresTenantRepository } from './tenant-repository.js';

export function createPostgresPersistence(config) {
  const pool = createPostgresPool(config);
  const tenantRepository = createPostgresTenantRepository(pool);

  return Object.freeze({
    pool,
    loadTenant: (tenantId) => tenantRepository.findById(tenantId),
    readinessChecks: [
      () => isPostgresReady(pool),
      () => isPostgresSchemaReady(pool),
    ],
    close: () => pool.end(),
  });
}
