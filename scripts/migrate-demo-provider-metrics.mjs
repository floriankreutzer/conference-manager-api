import pg from 'pg';
import { loadDemoConfig } from '../src/demo/config.js';
import { withDemoMetricsMigrationGate } from '../src/persistence/postgres/demo-metrics-migration-gate.js';
import { loadMigrations, migrateUp } from './db-migrations.mjs';
import { loadDemoMigrations, migrateDemoUp } from './demo-db-migrations.mjs';

let pool;
try {
  if (process.argv.length !== 2) throw new TypeError('INVALID_ARGUMENTS');
  const config = loadDemoConfig(process.env);
  const canonical = await loadMigrations(); const overlays = await loadDemoMigrations();
  if (canonical.length !== 69 || canonical.at(-1).version !== 69 || overlays.length !== 30 || overlays.at(-1).version !== 30) {
    throw new Error('DEMO_METRICS_MIGRATION_SOURCE_INVALID');
  }
  const roles = Object.freeze({ customer: config.databases.customer.role,
    platform: config.databases.platform.role, reset: config.databases.reset.role });
  pool = new pg.Pool({ connectionString: config.databases.migration.url,
    ssl: config.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
    max: 2, connectionTimeoutMillis: 10_000, query_timeout: 30_000,
    application_name: 'conference-manager-demo-metrics-migration' });
  const result = await withDemoMetricsMigrationGate(pool, { ...roles,
    migration: config.databases.migration.role, database: config.databaseTarget.database }, async () => {
    await migrateUp(pool);
    await migrateDemoUp(pool, { roles });
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, operation: 'provider_metrics_migration', ...result })}\n`);
} catch {
  // Driver/configuration failures must not print URLs, role credentials or private source values.
  process.stderr.write('DEMO_METRICS_MIGRATION_FAILED\n');
  process.exitCode = 1;
} finally { await pool?.end(); }
