import { loadMigrations } from './db-migrations.mjs';

const DEMO_MIGRATION_LOCK = 739_141_932_119;
const PRODUCTION_SCHEMA_VERSION = 44;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const PRODUCTION_SCHEMA_VERSIONS = Object.freeze(Array.from(
  { length: PRODUCTION_SCHEMA_VERSION },
  (_, index) => index + 1,
));

function validateRoles(roles) {
  const values = [roles?.customer, roles?.platform, roles?.reset];
  if (values.some((role) => typeof role !== 'string' || !ROLE_PATTERN.test(role))) {
    throw new TypeError('DEMO_MIGRATION_ROLES_INVALID');
  }
  if (new Set(values).size !== values.length) throw new TypeError('DEMO_MIGRATION_ROLES_INVALID');
  return Object.freeze({ customer: values[0], platform: values[1], reset: values[2] });
}

async function ensureProductionSchema(client) {
  const result = await client.query({
    name: 'demo-migration-production-schema',
    text: 'SELECT COALESCE(array_agg(version ORDER BY version), ARRAY[]::integer[]) AS versions FROM schema_migrations',
  });
  const versions = result.rows[0]?.versions?.map(Number);
  if (
    !Array.isArray(versions)
    || versions.length !== PRODUCTION_SCHEMA_VERSIONS.length
    || versions.some((version, index) => version !== PRODUCTION_SCHEMA_VERSIONS[index])
  ) {
    throw new Error('DEMO_MIGRATION_PRODUCTION_SCHEMA_NOT_READY');
  }
}

async function ensureDemoMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS demo_schema_migrations (
      version integer PRIMARY KEY,
      name varchar(128) NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

async function appliedMigrations(client) {
  const result = await client.query(`
    SELECT version, name, checksum
    FROM demo_schema_migrations
    ORDER BY version
  `);
  return result.rows;
}

function verifyApplied(applied, migrations) {
  const available = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = available.get(row.version);
    if (!migration) throw new Error(`DEMO_MIGRATION_SOURCE_MISSING:${row.version}`);
    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`DEMO_MIGRATION_CHECKSUM_MISMATCH:${row.version}`);
    }
  }
}

async function transaction(client, roles, work) {
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT set_config('conference_manager.demo_customer_role', $1, true)",
      [roles.customer],
    );
    await client.query(
      "SELECT set_config('conference_manager.demo_platform_role', $1, true)",
      [roles.platform],
    );
    await client.query(
      "SELECT set_config('conference_manager.demo_reset_role', $1, true)",
      [roles.reset],
    );
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export async function loadDemoMigrations(directory = 'demo-migrations') {
  return loadMigrations(directory);
}

export async function migrateDemoUp(pool, { directory = 'demo-migrations', roles } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  const validatedRoles = validateRoles(roles);
  const migrations = await loadDemoMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [DEMO_MIGRATION_LOCK]);
    await ensureProductionSchema(client);
    await ensureDemoMigrationTable(client);
    const applied = await appliedMigrations(client);
    verifyApplied(applied, migrations);
    const appliedVersions = new Set(applied.map(({ version }) => version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await transaction(client, validatedRoles, async () => {
        await client.query(migration.up);
        await client.query(
          'INSERT INTO demo_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
      });
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [DEMO_MIGRATION_LOCK]);
    } finally {
      client.release();
    }
  }
}

export async function rollbackLatestDemoMigration(pool, { directory = 'demo-migrations', roles } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  const validatedRoles = validateRoles(roles);
  const migrations = await loadDemoMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [DEMO_MIGRATION_LOCK]);
    await ensureProductionSchema(client);
    await ensureDemoMigrationTable(client);
    const applied = await appliedMigrations(client);
    verifyApplied(applied, migrations);
    const latest = applied.at(-1);
    if (!latest) return false;
    const migration = migrations.find(({ version }) => version === latest.version);
    await transaction(client, validatedRoles, async () => {
      await client.query(migration.down);
      await client.query('DELETE FROM demo_schema_migrations WHERE version = $1', [migration.version]);
    });
    return true;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [DEMO_MIGRATION_LOCK]);
    } finally {
      client.release();
    }
  }
}
