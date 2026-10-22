import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDemoConfig } from '../../src/demo/config.js';
import { requireOwnerMainActionsContext } from './owner-main-actions-context.mjs';

const URL_KEYS = ['DEMO_CUSTOMER_DATABASE_URL', 'DEMO_PLATFORM_DATABASE_URL',
  'DEMO_RESET_DATABASE_URL', 'DEMO_MIGRATION_DATABASE_URL'];
const PARSER_KEYS = ['DEMO_CUSTOMER_SESSION_SECRET', 'DEMO_CUSTOMER_CSRF_SECRET',
  'DEMO_PLATFORM_SESSION_SECRET', 'DEMO_PLATFORM_CSRF_SECRET', 'DEMO_TENANT_AUDIT_HMAC_SECRET'];
const NEON_HOST = /^(ep-[a-z0-9-]{3,80})\.(?:c-[1-9]\d*\.)?([a-z0-9-]{3,40}\.aws\.neon\.tech)$/;
const refuse = () => { throw new Error('RESTORED_MIGRATION_REFUSED'); };

export function restoredMigrationEnvironment(env) {
  try {
    requireOwnerMainActionsContext(env, 'protected-int-restore-migrate.yml');
    const encoded = env.CM_INT_RESTORE_REQUEST_JSON;
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 2048) refuse();
    const request = JSON.parse(encoded);
    const keys = ['sourceSha', 'sourceBranchId', 'targetBranchId', 'sourceHost', 'targetHost', 'snapshotId', 'servicesClosed'];
    if (!request || Array.isArray(request) || Object.keys(request).sort().join(',') !== keys.sort().join(',')
      || request.sourceSha !== env.GITHUB_SHA || request.servicesClosed !== true
      || ![request.sourceBranchId, request.targetBranchId].every(value =>
        typeof value === 'string' && /^br-[a-z0-9-]{3,80}$/.test(value))
      || request.sourceBranchId === request.targetBranchId || typeof request.snapshotId !== 'string'
      || !/^snap-[a-z0-9-]{3,80}$/.test(request.snapshotId)
      || Object.keys(env).some(key => /^PG/.test(key) && env[key])
      || URL_KEYS.some(key => typeof env[key] !== 'string' || env[key].length > 4096)) refuse();
    const source = typeof request.sourceHost === 'string' && request.sourceHost.match(NEON_HOST);
    const target = typeof request.targetHost === 'string' && request.targetHost.match(NEON_HOST);
    if (!source || !target || source[1].includes('-pooler') || target[1].includes('-pooler')
      || source[1] === target[1] || source[2] !== target[2]) refuse();
    const prepared = { ...env };
    // These values only satisfy the existing migration configuration parser.
    // Neither audit verification nor a runtime is started with them.
    for (const key of PARSER_KEYS) prepared[key] = randomBytes(32).toString('hex');
    const config = loadDemoConfig(prepared);
    if (config.databaseSsl !== 'verify-full' || config.databaseTarget.host !== request.sourceHost
      || config.databaseTarget.port !== '5432') refuse();
    for (const key of URL_KEYS) {
      const url = new URL(prepared[key]);
      url.hostname = request.targetHost;
      prepared[key] = url.href;
    }
    loadDemoConfig(prepared);
    delete prepared.CM_INT_RESTORE_REQUEST_JSON;
    return prepared;
  } catch { refuse(); }
}

export function runRestoredMigration(env, execute = spawnSync) {
  const prepared = restoredMigrationEnvironment(env);
  const result = execute(process.execPath, ['scripts/migrate-demo-provider-metrics.mjs'], {
    env: prepared, encoding: 'utf8', timeout: 120_000, maxBuffer: 16_384,
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
  });
  // Never forward raw child stdout/stderr or exception details into public CI.
  if (result.error || result.signal || result.status !== 0) refuse();
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { refuse(); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join(',') !==
      'canonicalVersion,demoVersion,operation,resetPerformed,retainedCountsMatch,schemaVersion'
    || receipt.schemaVersion !== 1 || receipt.operation !== 'provider_metrics_migration'
    || receipt.canonicalVersion !== 66 || receipt.demoVersion !== 29
    || receipt.resetPerformed !== false || receipt.retainedCountsMatch !== true) refuse();
}
