import {
  createPostgresPool,
  isPostgresReady,
  isPostgresSchemaReady,
} from './pool.js';
import { createPostgresAuditRepository } from './audit-repository.js';
import { createPostgresEntitlementRepository } from './entitlement-repository.js';
import { createPostgresRequestRepository } from './request-repository.js';
import { createPostgresSessionRepository } from './session-repository.js';
import { createPostgresTenantRepository } from './tenant-repository.js';

export function createPostgresPersistence(config) {
  const pool = createPostgresPool(config);
  const auditRepository = createPostgresAuditRepository(pool, {
    hmacSecret: config.auditHmacSecret,
  });
  const tenantRepository = createPostgresTenantRepository(pool);
  const entitlementRepository = createPostgresEntitlementRepository(pool, { auditRepository });
  const sessionRepository = createPostgresSessionRepository(pool, { auditRepository });
  const requestRepository = createPostgresRequestRepository(pool, { auditRepository });

  return Object.freeze({
    pool,
    auditRepository,
    entitlementRepository,
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
