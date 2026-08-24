import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MIGRATION_PATTERN = /^(\d{3})_([a-z0-9_]+)\.(up|down)\.sql$/;
const MIGRATION_LOCK = 739_141_932_118;

function checksum(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function loadMigrations(directory = 'migrations') {
  const names = await readdir(directory);
  const entries = new Map();

  for (const filename of names.sort()) {
    const match = filename.match(MIGRATION_PATTERN);
    if (!match) throw new Error(`INVALID_MIGRATION_FILENAME:${filename}`);
    const version = Number(match[1]);
    const name = match[2];
    const direction = match[3];
    const existing = entries.get(version) || { version, name };
    if (existing.name !== name || existing[direction]) throw new Error(`INVALID_MIGRATION_PAIR:${filename}`);
    existing[direction] = await readFile(path.join(directory, filename), 'utf8');
    entries.set(version, existing);
  }

  const migrations = [...entries.values()].sort((left, right) => left.version - right.version);
  for (const migration of migrations) {
    if (!migration.up || !migration.down) throw new Error(`INCOMPLETE_MIGRATION:${migration.version}`);
    migration.checksum = checksum(migration.up);
    Object.freeze(migration);
  }
  return Object.freeze(migrations);
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
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
    FROM schema_migrations
    ORDER BY version
  `);
  return result.rows;
}

async function transaction(client, work) {
  await client.query('BEGIN');
  try {
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

function verifyApplied(applied, migrations) {
  const available = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = available.get(row.version);
    if (!migration) throw new Error(`MIGRATION_SOURCE_MISSING:${row.version}`);
    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${row.version}`);
    }
  }
}

export async function migrateUp(pool, directory = 'migrations') {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await ensureMigrationTable(client);
    const applied = await appliedMigrations(client);
    verifyApplied(applied, migrations);
    const appliedVersions = new Set(applied.map((row) => row.version));

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await transaction(client, async () => {
        await client.query(migration.up);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
      });
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    } finally {
      client.release();
    }
  }
}

export async function rollbackLatest(pool, directory = 'migrations') {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await ensureMigrationTable(client);
    const applied = await appliedMigrations(client);
    verifyApplied(applied, migrations);
    const latest = applied.at(-1);
    if (!latest) return false;
    const migration = migrations.find((candidate) => candidate.version === latest.version);

    await transaction(client, async () => {
      await client.query(migration.down);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
    });
    return true;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    } finally {
      client.release();
    }
  }
}
