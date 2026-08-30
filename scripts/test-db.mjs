import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');

const testFiles = (await readdir('tests-db'))
  .filter((name) => name.endsWith('.test.js'))
  .sort();
const baseUrl = new URL(databaseUrl);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.toString() });

function databaseName(index) {
  return `conference_manager_test_${process.pid}_${index}`;
}

function identifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('TEST_DATABASE_NAME_INVALID');
  return `"${value}"`;
}

await admin.connect();
let failed = false;
try {
  for (const [index, file] of testFiles.entries()) {
    const name = databaseName(index);
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
    const testUrl = new URL(baseUrl);
    testUrl.pathname = `/${name}`;
    try {
      const result = spawnSync(process.execPath, [
        '--test', '--test-concurrency=1', `tests-db/${file}`,
      ], {
        env: { ...process.env, DATABASE_URL: testUrl.toString() },
        stdio: 'inherit',
        timeout: 120_000,
      });
      if (result.error || result.signal || result.status !== 0) {
        failed = true;
        break;
      }
    } finally {
      await admin.query(`DROP DATABASE ${identifier(name)} WITH (FORCE)`);
    }
  }
} finally {
  await admin.end();
}

if (failed) process.exitCode = 1;
