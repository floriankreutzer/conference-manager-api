import pg from 'pg';

import { loadDemoConfig } from '../src/demo/config.js';
import {
  migrateDemoUp,
  rollbackLatestDemoMigration,
} from './demo-db-migrations.mjs';

const { Pool } = pg;
const action = process.argv[2];
if (!['up', 'down'].includes(action)) throw new Error('DEMO_MIGRATION_ACTION_INVALID');

const config = loadDemoConfig(process.env);
const pool = new Pool({
  connectionString: config.databases.migration.url,
  ssl: config.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
  max: 1,
  application_name: 'conference-manager-demo-migrator',
});

const options = Object.freeze({
  roles: Object.freeze({
    customer: config.databases.customer.role,
    platform: config.databases.platform.role,
    reset: config.databases.reset.role,
  }),
});

try {
  if (action === 'up') await migrateDemoUp(pool, options);
  else await rollbackLatestDemoMigration(pool, options);
} finally {
  await pool.end();
}
