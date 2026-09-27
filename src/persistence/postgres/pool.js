import pg from 'pg';

const { Pool } = pg;

// Schema 19 established confirmed-booking change persistence.
// Schema 20 adds independent optimistic revision state for each mutable
// Tenant Admin settings aggregate without introducing a generic settings store.
// Schema 21 adds the bounded Locations/Rooms owner metadata and immutable
// location-revision history without fabricating legacy Site time zones.
// Schemas 22-25 add the bounded Organization, Catalogue, Booking Policies and
// Cost Allocation owners. Schema 26 adds User lifecycle concurrency state.
// Schema 27 adds authoritative Request composition snapshots, immutable Request
// history, Room pricing, and full confirmed-booking draft/snapshot proposals.
// Schema 28 adds bounded bulk-transfer receipts. Schemas 29-33 establish the
// independent Platform security, operations, metering and runtime stores.
// Schema 34 irreversibly revokes pre-authorization-epoch Customer sessions.
// Schema 35 admits Request composition v3 equipment selection evidence.
// Schema 36 persists minimized Request requester/action attribution snapshots.
// Schema 37 adds versioned Site Guest Information to Locations history.
// Schema 38 confines Request-attribution SECURITY DEFINER execution to its trigger path.
// Schema 39 stores reencoded, private Room imagery with Tenant and Room ownership.
// Schema 40 stores bounded public Site and Room Guest values, retaining legacy prose privately.
export const CURRENT_SCHEMA_VERSION = 40;

const PRODUCTION_APPLICATION_NAMES = new Set([
  'conference-manager-api',
  'conference-manager-platform-api',
]);
const DEMO_APPLICATION_NAMES = new Set([
  'conference-manager-demo-customer-gate',
  'conference-manager-demo-platform-gate',
  'conference-manager-demo-reset',
]);

export function createPostgresPool(config) {
  if (!config?.databaseUrl) throw new TypeError('DATABASE_URL_REQUIRED');
  const applicationName = config.applicationName || 'conference-manager-api';
  if (
    !PRODUCTION_APPLICATION_NAMES.has(applicationName)
    && !(config.demoRuntime === true && DEMO_APPLICATION_NAMES.has(applicationName))
  ) {
    throw new TypeError('DATABASE_APPLICATION_NAME_INVALID');
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    statement_timeout: config.databaseStatementTimeoutMs,
    query_timeout: config.databaseStatementTimeoutMs,
    application_name: applicationName,
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
