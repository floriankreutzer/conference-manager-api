import {
  loadMigrations,
  migrateUp,
  rollbackLatest as rollbackLatestProduction,
  rollbackToVersion as rollbackToVersionProduction,
} from '../../scripts/db-migrations.mjs';
import { clearSaas3TestState } from './saas3-test-state.js';

export { loadMigrations, migrateUp };

export async function rollbackLatest(pool, directory = 'migrations') {
  await clearSaas3TestState(pool);
  return rollbackLatestProduction(pool, directory);
}

export async function rollbackToVersion(pool, targetVersion, directory = 'migrations') {
  await clearSaas3TestState(pool);
  return rollbackToVersionProduction(pool, targetVersion, directory);
}
