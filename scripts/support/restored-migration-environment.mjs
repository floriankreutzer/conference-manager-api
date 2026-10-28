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
const TOOLCHAIN_PG_KEYS = new Set(['PG_CONFIG', 'PGBIN', 'PGROOT', 'PGDATA', 'PG_VERSION']);
const FAILURE_CODES = new Set(['CONTEXT', 'BINDING', 'RUNNER', 'SOURCE', 'TARGET', 'NATIVE', 'RECEIPT']
  .map(stage => `RESTORED_MIGRATION_${stage}_REFUSED`));
const refuse = (stage = 'BINDING') => { throw new Error(`RESTORED_MIGRATION_${stage}_REFUSED`); };
export function restoredMigrationFailureCode(error) {
  return FAILURE_CODES.has(error?.message) ? error.message : 'RESTORED_MIGRATION_REFUSED';
}

export function restoredMigrationEnvironment(env) {
  let stage = 'CONTEXT';
  try {
    requireOwnerMainActionsContext(env, 'protected-int-restore-migrate.yml');
    stage = 'BINDING';
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
      || URL_KEYS.some(key => typeof env[key] !== 'string' || env[key].length > 4096)) refuse();
    const source = typeof request.sourceHost === 'string' && request.sourceHost.match(NEON_HOST);
    const target = typeof request.targetHost === 'string' && request.targetHost.match(NEON_HOST);
    if (!source || !target || source[1].includes('-pooler') || target[1].includes('-pooler')
      || source[1] === target[1] || source[2] !== target[2]) refuse();
    const prepared = { ...env };
    stage = 'RUNNER';
    let discardedToolchainMetadata = false;
    for (const key of Object.keys(env).filter(key => /^PG/.test(key) && env[key])) {
      if (!TOOLCHAIN_PG_KEYS.has(key)) refuse();
      delete prepared[key];
      discardedToolchainMetadata = true;
    }
    // These values only satisfy the existing migration configuration parser.
    // Neither audit verification nor a runtime is started with them.
    for (const key of PARSER_KEYS) prepared[key] = randomBytes(32).toString('hex');
    stage = 'SOURCE';
    const config = loadDemoConfig(prepared);
    const actualSource = config.databaseTarget.host.match(NEON_HOST);
    // Old saved URLs may use a proxy or pooler alias of this same source endpoint.
    // The independently selected destination must always remain a different direct endpoint.
    if (config.databaseSsl !== 'verify-full' || !actualSource
      || actualSource[1].replace(/-pooler$/, '') !== source[1] || actualSource[2] !== source[2]
      || config.databaseTarget.port !== '5432') refuse();
    const normalizedSourceAlias = config.databaseTarget.host !== request.sourceHost;
    for (const key of URL_KEYS) {
      const url = new URL(prepared[key]);
      url.hostname = request.targetHost;
      prepared[key] = url.href;
    }
    stage = 'TARGET';
    loadDemoConfig(prepared);
    delete prepared.CM_INT_RESTORE_REQUEST_JSON;
    return { env: prepared, normalizedSourceAlias, discardedToolchainMetadata };
  } catch { refuse(stage); }
}

export function runRestoredMigration(env, execute = spawnSync) {
  const prepared = restoredMigrationEnvironment(env);
  let result;
  try {
    result = execute(process.execPath, ['scripts/migrate-demo-provider-metrics.mjs'], {
      env: prepared.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16_384,
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
    });
  } catch { refuse('NATIVE'); }
  // Never forward raw child stdout/stderr or exception details into public CI.
  if (!result || result.error || result.signal || result.status !== 0) refuse('NATIVE');
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { refuse('RECEIPT'); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join(',') !==
      'canonicalVersion,demoVersion,operation,resetPerformed,retainedCountsMatch,schemaVersion'
    || receipt.schemaVersion !== 1 || receipt.operation !== 'provider_metrics_migration'
    || receipt.canonicalVersion !== 73 || receipt.demoVersion !== 33
    || receipt.resetPerformed !== false || receipt.retainedCountsMatch !== true) refuse('RECEIPT');
  return { normalizedSourceAlias: prepared.normalizedSourceAlias,
    discardedToolchainMetadata: prepared.discardedToolchainMetadata };
}
