import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { createNeonObjectStorage } from '../src/media/neon-object-storage.js';
import { loadLiveMediaRecord, loadLiveMediaOperation, LIVE_MEDIA_LIMITS, liveMediaFail } from './support/live-media-operator-config.mjs';
import { assertLiveMediaSourceBinding } from './support/live-media-source-binding.mjs';
import { assertOperatorIdentity, assertNoOtherDatabaseSessions, readLiveMediaInventory } from './support/live-media-operator-db.mjs';
import { initialLiveMediaReport, runLiveMediaOperation } from './support/live-media-operator-run.mjs';
import { assertLiveRuntimesClosed } from './support/live-media-operator-http.mjs';

const processStartedAt = Date.now();
const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = new URL('../live-media-operator-result.json', import.meta.url);
const persist = (report) => writeFileSync(reportPath, JSON.stringify(report) + '\n', { mode: 0o600 });
let report = { schemaVersion: 1, status: 'failed', complete: false, mutationOutcome: 'not_started',
  code: 'LIVE_MEDIA_CONFIGURATION_INVALID' };
let client;
let storage;
let child;
let watchdog;

function batch(operation) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_SSL: 'verify-full',
      MEDIA_MIGRATION_DATABASE_URL: operation.databaseUrl, MEDIA_MIGRATION_DATABASE_ROLE: operation.record.operatorRole,
      MEDIA_OPERATOR_ENDPOINT: operation.storage.endpoint, MEDIA_OPERATOR_REGION: operation.storage.region,
      MEDIA_OPERATOR_BUCKET: operation.storage.bucket, MEDIA_OPERATOR_ACCESS_KEY_ID: operation.storage.accessKeyId,
      MEDIA_OPERATOR_SECRET_ACCESS_KEY: operation.storage.secretAccessKey };
    child = spawn(process.execPath, ['scripts/private-media-migration.mjs', '--execute', operation.action, operation.kind],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let invalid = false;
    const timeout = setTimeout(() => { invalid = true; child?.kill('SIGKILL'); }, LIVE_MEDIA_LIMITS.batchMs);
    child.stdout.on('data', (data) => {
      if (Buffer.byteLength(output) + data.length > 2048) { invalid = true; child?.kill('SIGKILL'); return; }
      output += data.toString('utf8');
    });
    child.once('error', () => { invalid = true; });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      child = undefined;
      if (invalid || code !== 0 || signal) {
        reject(Object.assign(new Error('LIVE_MEDIA_BATCH_OUTCOME_UNKNOWN'), { code: 'LIVE_MEDIA_BATCH_OUTCOME_UNKNOWN' }));
      } else resolve(output);
    });
  });
}

try {
  if (process.argv.length !== 2) liveMediaFail('LIVE_MEDIA_CONFIGURATION_INVALID');
  const selection = loadLiveMediaRecord(process.env);
  const sourceSha = assertLiveMediaSourceBinding({ sourceSha: selection.record.sourceSha, controllerSha: selection.controllerSha,
    expectedHead: selection.record.sourceSha, repository: root });
  const operation = loadLiveMediaOperation(process.env, { sourceSha });
  report = initialLiveMediaReport(operation);
  persist(report);
  const abort = () => {
    child?.kill('SIGKILL');
    report.status = 'failed';
    report.complete = false;
    report.code = 'LIVE_MEDIA_INTERRUPTED';
    try { persist(report); } catch { /* Missing evidence is an unknown outcome, never a successful run. */ }
    process.exit(1);
  };
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const processDeadline = Math.min(processStartedAt + LIVE_MEDIA_LIMITS.processMs, operation.expiresAt);
  watchdog = setTimeout(abort, processDeadline - Date.now());
  client = new Client({ connectionString: operation.databaseUrl, ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000, statement_timeout: 10_000, query_timeout: 12_000,
    application_name: 'cm-live-media-operator' });
  // Idle socket failures are EventEmitter errors outside awaited query promises.
  // Never let a driver Error/configuration reach an uncaught stack or the runner log.
  client.on('error', abort);
  await client.connect();
  // One operator session remains open for independent before/after snapshots;
  // the existing migration CLI owns its separate short-lived mutation connection.
  const lock = await client.query('SELECT pg_try_advisory_lock(1835102821, 20261011) AS acquired');
  if (lock.rows[0]?.acquired !== true) liveMediaFail('LIVE_MEDIA_DATABASE_NOT_QUIESCENT');
  report = await runLiveMediaOperation(operation, {
    now: Date.now, persist, processDeadline,
    identity: () => assertOperatorIdentity(client, operation.record.operatorRole),
    quiescent: () => assertNoOtherDatabaseSessions(client, (diagnostic) => { report.databaseQuiescence = diagnostic; }),
    closed: assertLiveRuntimesClosed,
    inventory: () => readLiveMediaInventory(client), batch: () => batch(operation),
    get: (reference) => {
      storage ??= createNeonObjectStorage(operation.storage);
      return storage.get(reference);
    },
  }, report);
} catch {
  report.status = 'failed';
  report.complete = false;
  report.code = 'LIVE_MEDIA_FAILED';
} finally {
  try { storage?.close(); } catch { report.status = 'failed'; report.complete = false; report.code = 'LIVE_MEDIA_CLEANUP_FAILED'; }
  try { await client?.end(); } catch { report.status = 'failed'; report.complete = false; report.code = 'LIVE_MEDIA_CLEANUP_FAILED'; }
  clearTimeout(watchdog);
  try { persist(report); } catch {
    report.status = 'failed'; report.complete = false; report.code = 'LIVE_MEDIA_EVIDENCE_WRITE_FAILED';
  }
  try { process.stdout.write(JSON.stringify(report) + '\n'); } catch { process.exitCode = 1; }
  if (report.status === 'failed') process.exitCode = 1;
}
