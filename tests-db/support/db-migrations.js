import {
  loadMigrations,
  migrateUp,
  rollbackLatest as rollbackLatestProduction,
  rollbackToVersion as rollbackToVersionProduction,
} from '../../scripts/db-migrations.mjs';
import { clearSaas3TestState } from './saas3-test-state.js';

export { loadMigrations, migrateUp };

async function prepareSaas3Rollback(pool) {
  await clearSaas3TestState(pool);
  const result = await pool.query('SELECT COALESCE(MAX(version), 0)::integer AS version FROM schema_migrations');
  if (result.rows[0].version < 31) return;
  await pool.query('ALTER TABLE tenants DISABLE TRIGGER tenants_platform_revisions');
  await pool.query('ALTER TABLE tenant_onboarding_invitations DISABLE TRIGGER tenant_onboarding_invitations_revision_guard');
  await pool.query('ALTER TABLE tenant_identity_bindings DISABLE TRIGGER tenant_identity_bindings_revision_guard');
  await pool.query('ALTER TABLE microsoft365_room_mappings DISABLE TRIGGER microsoft365_room_mappings_revision_guard');
  try {
    await pool.query(`UPDATE tenants
                      SET lifecycle_revision = 1,
                          entitlement_revision = 1,
                          customer_session_revision = 1`);
    await pool.query(`UPDATE tenant_onboarding_invitations
                      SET revision = 1, revoked_at = NULL, reissued_from_id = NULL`);
    await pool.query('UPDATE tenant_identity_bindings SET revision = 1');
    await pool.query('UPDATE microsoft365_room_mappings SET revision = 1');
  } finally {
    await pool.query('ALTER TABLE microsoft365_room_mappings ENABLE TRIGGER microsoft365_room_mappings_revision_guard');
    await pool.query('ALTER TABLE tenant_identity_bindings ENABLE TRIGGER tenant_identity_bindings_revision_guard');
    await pool.query('ALTER TABLE tenant_onboarding_invitations ENABLE TRIGGER tenant_onboarding_invitations_revision_guard');
    await pool.query('ALTER TABLE tenants ENABLE TRIGGER tenants_platform_revisions');
  }
}

export async function rollbackLatest(pool, directory = 'migrations') {
  await prepareSaas3Rollback(pool);
  return rollbackLatestProduction(pool, directory);
}

export async function rollbackToVersion(pool, targetVersion, directory = 'migrations') {
  await prepareSaas3Rollback(pool);
  return rollbackToVersionProduction(pool, targetVersion, directory);
}
