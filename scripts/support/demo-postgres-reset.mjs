import { createDemoResetService } from '../../src/demo/reset-service.js';
import { createPostgresDemoResetRepository } from '../../src/persistence/postgres/demo-reset-repository.js';
import { assertDemoMediaStorageReady } from '../../src/persistence/postgres/demo-media-storage-readiness.js';
import { migrateDemoUp } from '../demo-db-migrations.mjs';

export async function resetPostgresDemo({ config, migrationPool, resetPool, onSemanticMismatch = null }, {
  migrate = migrateDemoUp,
  createRepository = createPostgresDemoResetRepository,
} = {}) {
  const roles = Object.freeze({ customer: config.databases.customer.role,
    platform: config.databases.platform.role, reset: config.databases.reset.role });
  await migrate(migrationPool, { roles });
  // Preserve overlay bootstrap, then refuse destructive PostgreSQL reset if either
  // canonical media table already publishes external object pointers.
  await assertDemoMediaStorageReady(resetPool, { mode: 'postgres',
    expectedDatabaseName: config.databaseTarget.database, expectedRole: config.databases.reset.role });
  const repository = createRepository({ pool: resetPool,
    expectedDatabaseName: config.databaseTarget.database, expectedResetRole: config.databases.reset.role,
    onSemanticMismatch });
  return createDemoResetService({ repository }).reset();
}
