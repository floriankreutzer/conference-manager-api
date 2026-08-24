import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from './db-migrations.mjs';

const action = process.argv[2];
if (!['up', 'down'].includes(action)) throw new Error('MIGRATION_ACTION_INVALID');

const mode = process.env.NODE_ENV || 'development';
const database = loadDatabaseConfig(process.env, mode);
if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED');

const pool = createPostgresPool({ mode, ...database });
try {
  if (action === 'up') await migrateUp(pool);
  else await rollbackLatest(pool);
} finally {
  await pool.end();
}
