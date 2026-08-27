import pg from 'pg';

const { Pool } = pg;

// Schema 20 adds independent optimistic revision state for each mutable
// Tenant Admin settings aggregate without introducing a generic settings store.
// Schemas 21-25 add the five bounded Tenant Admin settings aggregates.
export const CURRENT_SCHEMA_VERSION = 25;

export function createPostgresPool(config) {
  if (!config?.databaseUrl) throw new TypeError('DATABASE_URL_REQUIRED');

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    statement_timeout: config.databaseStatementTimeoutMs,
    query_timeout: config.databaseStatementTimeoutMs,
    application_name: 'conference-manager-api',
    allowExitOnIdle: config.mode === 'test',
  });

  pool.on('error', () => {
    // Pool background errors are observed by readiness and request failures.
    // Do not log the Error object because driver errors can contain connection metadata.
  });

  return pool;
}

export async function isPostgresReady(pool) {
  const result = await pool.query('SELECT 1 AS ready');
  return result.rows[0]?.ready === 1;
}

export async function isPostgresSchemaReady(pool, expectedVersion = CURRENT_SCHEMA_VERSION) {
  const result = await pool.query({
    name: 'schema-readiness',
    text: `
      SELECT COALESCE(MAX(version), 0) AS version
      FROM schema_migrations
    `,
  });
  return Number(result.rows[0]?.version) === expectedVersion;
}
