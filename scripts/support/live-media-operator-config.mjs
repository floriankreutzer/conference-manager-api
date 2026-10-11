import { createHash } from 'node:crypto';
import { validateNeonStorageConfig } from '../../src/media/neon-storage-config.js';

export const LIVE_MEDIA_TARGET = Object.freeze({
  projectId: 'divine-shape-86658581',
  branchId: 'br-summer-rice-b1f8voyp',
  databaseEndpointId: 'ep-solitary-thunder-b1ydpuiq',
  databaseHost: 'ep-solitary-thunder-b1ydpuiq.c-5.eu-central-1.aws.neon.tech',
  databaseName: 'conference_manager_demo_shared',
  bucket: 'conference-manager-media',
  region: 'eu-central-1',
  deployedSourceSha: '566402fd098c298ff09ec3230ddd0b55d4ea91f6',
  servedFrontendSha: '5d5102b4f9842ec704ff26441ebe96719324ddb0',
  operatorRole: 'cm_demo_migration',
});
export const LIVE_MEDIA_LIMITS = Object.freeze({
  operationMs: 5_400_000, processMs: 180_000, batchMs: 60_000,
  finishReserveMs: 15_000, maxAssets: 1_000, maxBytes: 128 * 1024 * 1024,
});
const HEX = /^[a-f0-9]{64}$/;
const RECORD_KEYS = [
  'schemaVersion', 'operationId', 'direction', 'sourceSha', ...Object.keys(LIVE_MEDIA_TARGET),
  'issuedAt', 'expiresAt', 'manifestSha256', 'externalEvidenceSha256', 'recoveryEvidenceSha256',
  'customerDeploymentId', 'platformDeploymentId',
];
const FORBIDDEN_ENV = ['NODE_OPTIONS', 'NODE_DEBUG', 'DEBUG', 'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'RUNNER_DEBUG', 'ACTIONS_STEP_DEBUG', 'ACTIONS_RUNNER_DEBUG'];
const RUNTIME_ROLES = new Set(['cm_demo_customer', 'cm_demo_platform', 'cm_demo_reset', 'postgres', 'neondb_owner']);

export function liveMediaFail(code = 'LIVE_MEDIA_FAILED') {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function requireLiveMedia(value, code = 'LIVE_MEDIA_CONFIGURATION_INVALID') {
  if (!value) liveMediaFail(code);
}

export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function timestamp(value) {
  requireLiveMedia(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
  const parsed = Date.parse(value);
  requireLiveMedia(Number.isFinite(parsed) && new Date(parsed).toISOString() === value);
  return parsed;
}

export function loadLiveMediaRecord(env, { now = Date.now() } = {}) {
  const action = env.LIVE_MEDIA_ACTION;
  const kind = env.LIVE_MEDIA_KIND;
  requireLiveMedia(['preflight', 'reconcile', 'copy', 'rollback'].includes(action)
    && (['copy', 'rollback'].includes(action) ? ['room', 'catalogue'].includes(kind) : kind === 'none'));
  requireLiveMedia(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REPOSITORY === 'floriankreutzer/conference-manager-api' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_ACTOR === 'floriankreutzer'
    && env.GITHUB_TRIGGERING_ACTOR === 'floriankreutzer' && /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID || '')
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    && FORBIDDEN_ENV.every((key) => env[key] === undefined), 'LIVE_MEDIA_EXECUTION_CONTEXT_INVALID');
  const raw = env.LIVE_MEDIA_OPERATION_JSON;
  requireLiveMedia(typeof raw === 'string' && raw.length <= 8192 && HEX.test(env.LIVE_MEDIA_RECORD_SHA256 || ''));
  let record;
  try { record = JSON.parse(raw); } catch { liveMediaFail('LIVE_MEDIA_RECORD_INVALID'); }
  // A compact exact JSON representation rejects duplicate keys and binds every byte
  // of the same immutable operation record across all manually selected batches.
  requireLiveMedia(exactKeys(record, RECORD_KEYS) && raw === JSON.stringify(record)
    && sha256(raw) === env.LIVE_MEDIA_RECORD_SHA256, 'LIVE_MEDIA_RECORD_INVALID');
  requireLiveMedia(record.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(record.operationId || '')
    && ['copy', 'rollback'].includes(record.direction)
    && /^[a-f0-9]{40}$/.test(record.sourceSha || '')
    && Object.entries(LIVE_MEDIA_TARGET).every(([key, value]) => record[key] === value)
    && /^[a-z][a-z0-9_]{2,62}$/.test(record.operatorRole || '') && !RUNTIME_ROLES.has(record.operatorRole)
    && HEX.test(record.externalEvidenceSha256 || '') && HEX.test(record.recoveryEvidenceSha256 || '')
    && /^dep-[a-z0-9]{10,40}$/.test(record.customerDeploymentId || '')
    && /^dep-[a-z0-9]{10,40}$/.test(record.platformDeploymentId || '')
    && record.customerDeploymentId !== record.platformDeploymentId
    && (record.manifestSha256 === null && action === 'preflight' || HEX.test(record.manifestSha256 || ''))
    && (!['copy', 'rollback'].includes(action) || action === record.direction), 'LIVE_MEDIA_RECORD_INVALID');
  const issuedAt = timestamp(record.issuedAt);
  const expiresAt = timestamp(record.expiresAt);
  requireLiveMedia(issuedAt <= now && expiresAt > issuedAt && expiresAt - issuedAt <= LIVE_MEDIA_LIMITS.operationMs
    && now + LIVE_MEDIA_LIMITS.finishReserveMs < expiresAt, 'LIVE_MEDIA_DEADLINE_EXPIRED');
  return Object.freeze({ action, kind, record: Object.freeze(record), recordSha256: sha256(raw), expiresAt,
    runId: env.GITHUB_RUN_ID, controllerSha: env.GITHUB_SHA });
}

export function loadLiveMediaOperation(env, { now = Date.now(), sourceSha } = {}) {
  const operation = loadLiveMediaRecord(env, { now });
  const { record } = operation;
  requireLiveMedia(sourceSha === record.sourceSha, 'LIVE_MEDIA_SOURCE_INVALID');
  let url;
  try { url = new URL(env.CM_NEON_LIVE_OPERATOR_DATABASE_URL); } catch { liveMediaFail('LIVE_MEDIA_DATABASE_INVALID'); }
  requireLiveMedia(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === record.databaseHost
    && (!url.port || url.port === '5432') && url.pathname === '/' + record.databaseName
    && url.username === record.operatorRole && url.password.length >= 16 && url.password.length <= 1024
    && !url.search && !url.hash, 'LIVE_MEDIA_DATABASE_INVALID');
  requireLiveMedia(Object.entries(env).every(([key, value]) => !value
    || !/^(?:CM_NEON_RECOVERY_|DEMO_.*(?:DATABASE_URL|SECRET|TOKEN|ACCESS_KEY)|HOSTED_DEMO_|MEDIA_OPERATOR_|MEDIA_MIGRATION_)/.test(key))
    && !env.DATABASE_URL,
  'LIVE_MEDIA_SECRET_SCOPE_INVALID');
  let storage;
  try {
    storage = validateNeonStorageConfig({
      endpoint: 'https://' + record.branchId + '.storage.c-5.eu-central-1.aws.neon.tech',
      region: record.region, bucket: record.bucket,
      accessKeyId: env.CM_NEON_LIVE_OPERATOR_ACCESS_KEY_ID,
      secretAccessKey: env.CM_NEON_LIVE_OPERATOR_SECRET_ACCESS_KEY,
    });
  } catch { liveMediaFail('LIVE_MEDIA_STORAGE_INVALID'); }
  let password;
  try { password = decodeURIComponent(url.password); } catch { liveMediaFail('LIVE_MEDIA_DATABASE_INVALID'); }
  requireLiveMedia(storage.accessKeyId !== storage.secretAccessKey
    && ![storage.accessKeyId, storage.secretAccessKey].includes(password),
  'LIVE_MEDIA_SECRET_SCOPE_INVALID');
  return Object.freeze({ ...operation, databaseUrl: env.CM_NEON_LIVE_OPERATOR_DATABASE_URL, storage });
}

export function requireLiveMediaReserve(operation, now, milliseconds) {
  requireLiveMedia(Number.isFinite(now) && now + milliseconds < operation.expiresAt, 'LIVE_MEDIA_DEADLINE_EXPIRED');
}
