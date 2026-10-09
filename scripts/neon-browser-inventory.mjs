import { Client } from 'pg';
import { writeFile } from 'node:fs/promises';
import { assertNeonBrowserDatabase } from './support/neon-browser-config.mjs';
import { ACCEPTANCE_BRANCH } from './support/neon-acceptance-probe.mjs';

let client;
try {
  if (process.argv.length !== 2 || process.env.NODE_ENV !== 'test' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) {
    throw new Error('NEON_BROWSER_INVENTORY_INVALID');
  }
  if (!process.env.DEMO_MIGRATION_DATABASE_URL) throw new Error('NEON_BROWSER_INVENTORY_INVALID');
  assertNeonBrowserDatabase(process.env);
  client = new Client({ connectionString: process.env.DEMO_MIGRATION_DATABASE_URL,
    connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const result = await client.query(`SELECT object_key, content_type, byte_length,
    encode(content_sha256, 'hex') AS sha256, registered_at
    FROM media_object_inventory ORDER BY object_key LIMIT 10001`);
  if (result.rows.length > 10000) throw new Error('NEON_BROWSER_INVENTORY_TOO_LARGE');
  await client.query('COMMIT');
  await writeFile('neon-browser-inventory.json', `${JSON.stringify({ schemaVersion: 1,
    scope: 'isolated-application-custody-not-restore', sourceRuntimeRef: process.env.GITHUB_SHA,
    branch: ACCEPTANCE_BRANCH, objects: result.rows })}\n`, { mode: 0o600, flag: 'wx' });
} catch {
  process.stderr.write('NEON_BROWSER_INVENTORY_FAILED\n');
  process.exitCode = 1;
} finally { await client?.end(); }
