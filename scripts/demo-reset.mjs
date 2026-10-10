import pg from 'pg';

import { loadDemoConfig } from '../src/demo/config.js';
import { assertDemoPostgresStorageConfiguration } from '../src/demo/media-storage-config.js';
import { resetPostgresDemo } from './support/demo-postgres-reset.mjs';

const { Pool } = pg;
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{2,127}$/;

function output(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

let migrationPool;
let resetPool;
try {
  assertDemoPostgresStorageConfiguration(process.env);
  const config = loadDemoConfig(process.env);
  if (process.argv[2] !== `--confirm-seed-version=${config.seedVersion}`) {
    throw new Error('DEMO_RESET_CONFIRMATION_REQUIRED');
  }
  migrationPool = new Pool({
    connectionString: config.databases.migration.url,
    ssl: config.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
    max: 1,
    application_name: 'conference-manager-demo-migrator',
  });
  resetPool = new Pool({
    connectionString: config.databases.reset.url,
    ssl: config.databaseSsl === 'verify-full' ? { rejectUnauthorized: true } : false,
    max: 1,
    application_name: 'conference-manager-demo-reset',
  });
  const result = await resetPostgresDemo({ config, migrationPool, resetPool,
    onSemanticMismatch: process.env.NODE_ENV === 'test'
      ? (path) => process.stderr.write(`DEMO_SEMANTIC_PATH: ${path?.slice(0, 120) || 'unknown'}\n`)
      : null,
  });
  output(process.stdout, Object.freeze({ status: 'completed', result }));
} catch (error) {
  const candidate = error?.code || error?.message;
  output(process.stderr, Object.freeze({
    status: 'failed',
    code: SAFE_ERROR.test(candidate || '') ? candidate : 'DEMO_RESET_FAILED',
    ...(process.env.NODE_ENV === 'test' ? {
      diagnostic: {
        sqlstate: /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : null,
        constraint: /^[a-z][a-z0-9_]{0,100}$/.test(error?.constraint || '') ? error.constraint : null,
      },
    } : {}),
  }));
  process.exitCode = 1;
} finally {
  try {
    await migrationPool?.end();
  } catch {
    process.exitCode = 1;
  }
  try {
    await resetPool?.end();
  } catch {
    process.exitCode = 1;
  }
}
