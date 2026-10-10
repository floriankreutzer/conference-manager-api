import { createNeonBranchStorageConfig, validateNeonStorageBranchId } from '../media/neon-storage-config.js';
import { DemoConfigError } from './config.js';

const MODE_KEY = 'DEMO_MEDIA_STORAGE';
const BINDING_KEYS = Object.freeze(['DEMO_MEDIA_STORAGE_BRANCH_ID', 'DEMO_MEDIA_STORAGE_DATABASE_HOST']);
const CREDENTIAL_KEYS = Object.freeze({
  customer: Object.freeze(['DEMO_CUSTOMER_MEDIA_STORAGE_ACCESS_KEY_ID', 'DEMO_CUSTOMER_MEDIA_STORAGE_SECRET_ACCESS_KEY']),
  platform: Object.freeze(['DEMO_RESET_MEDIA_STORAGE_ACCESS_KEY_ID', 'DEMO_RESET_MEDIA_STORAGE_SECRET_ACCESS_KEY']),
});
const KNOWN_KEYS = new Set([MODE_KEY, ...BINDING_KEYS, ...Object.values(CREDENTIAL_KEYS).flat()]);
const STORAGE_KEY = /^DEMO_(?:(?:CUSTOMER|PLATFORM|RESET)_)?MEDIA_STORAGE(?:_|$)/;
const DATABASE_KEYS = Object.freeze({ customer: 'DEMO_CUSTOMER_DATABASE_URL',
  platform: 'DEMO_PLATFORM_DATABASE_URL', reset: 'DEMO_RESET_DATABASE_URL' });
const ROLES = Object.freeze({ customer: 'cm_demo_customer', platform: 'cm_demo_platform', reset: 'cm_demo_reset' });
const HOST = /^ep-[a-z0-9-]{5,80}\.c-5\.eu-central-1\.aws\.neon\.tech$/;

function fail(code) {
  throw new DemoConfigError(code);
}

function occupied(value) {
  return value !== undefined && value !== '';
}

function storageEntries(env) {
  return Object.entries(env).filter(([key, value]) => STORAGE_KEY.test(key) && occupied(value));
}

// Empty cleared values permit an explicit PostgreSQL rollback without replacing all
// Render environment variables. A nonempty unused key is always a configuration error.
export function assertDemoPostgresStorageConfiguration(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || ![undefined, 'postgres'].includes(env[MODE_KEY])
    || storageEntries(env).some(([key]) => key !== MODE_KEY)) {
    fail('DEMO_MEDIA_STORAGE_POSTGRES_CONFIGURATION_REQUIRED');
  }
}

function assertNeonDatabase(env, config, surface, host) {
  const names = surface === 'customer' ? ['customer'] : ['platform', 'reset'];
  if (config.environment !== 'demo' || env.NODE_ENV !== 'demo' || config.databaseSsl !== 'verify-full'
    || env.DEMO_DATABASE_SSL !== 'verify-full' || !HOST.test(host || '')
    || Object.keys(config.databases || {}).length !== names.length) fail('DEMO_MEDIA_STORAGE_DATABASE_BINDING_INVALID');
  for (const name of names) {
    const database = config.databases?.[name];
    let url;
    try { url = new URL(database?.url); } catch { fail('DEMO_MEDIA_STORAGE_DATABASE_BINDING_INVALID'); }
    if (database.url !== env[DATABASE_KEYS[name]] || database.role !== ROLES[name]
      || !['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== host
      || (url.port && url.port !== '5432') || url.pathname !== '/conference_manager_demo_shared'
      || url.username !== ROLES[name] || !url.password || url.search || url.hash
      || config.databaseTarget?.host !== host || config.databaseTarget?.port !== '5432'
      || config.databaseTarget?.database !== 'conference_manager_demo_shared') {
      fail('DEMO_MEDIA_STORAGE_DATABASE_BINDING_INVALID');
    }
  }
}

export function loadDemoMediaStorageConfig(env, { config, surface } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || !['customer', 'platform'].includes(surface)
    || !config || config.runtime !== 'shared-postgres-v1') fail('DEMO_MEDIA_STORAGE_CONTEXT_INVALID');
  const mode = env[MODE_KEY] ?? 'postgres';
  if (!['postgres', 'neon'].includes(mode)) fail('DEMO_MEDIA_STORAGE_MODE_INVALID');
  if (mode === 'postgres') {
    assertDemoPostgresStorageConfiguration(env);
    return Object.freeze({ mode, storage: null });
  }
  const allowed = new Set([MODE_KEY, ...BINDING_KEYS, ...CREDENTIAL_KEYS[surface]]);
  if (storageEntries(env).some(([key]) => !KNOWN_KEYS.has(key) || !allowed.has(key))) {
    fail('DEMO_MEDIA_STORAGE_EXCESS_CONFIGURATION_FORBIDDEN');
  }
  let branch;
  try { branch = validateNeonStorageBranchId(env.DEMO_MEDIA_STORAGE_BRANCH_ID); }
  catch { fail('DEMO_MEDIA_STORAGE_BRANCH_INVALID'); }
  const host = env.DEMO_MEDIA_STORAGE_DATABASE_HOST;
  assertNeonDatabase(env, config, surface, host);
  const [accessKey, secretKey] = CREDENTIAL_KEYS[surface];
  let storage;
  try {
    storage = createNeonBranchStorageConfig({
      branch, bucket: 'conference-manager-media',
      accessKeyId: env[accessKey], secretAccessKey: env[secretKey],
    });
  } catch { fail('DEMO_MEDIA_STORAGE_CREDENTIAL_INVALID'); }
  const unrelatedSecrets = [...Object.values(config.secrets || {}),
    ...Object.values(config.databases).map(({ password }) => password)];
  if (storage.accessKeyId === storage.secretAccessKey
    || unrelatedSecrets.some((secret) => secret === storage.accessKeyId || secret === storage.secretAccessKey)) {
    fail('DEMO_MEDIA_STORAGE_SECRET_ALIAS_FORBIDDEN');
  }
  // These operator pins must first be matched to provider control-plane metadata.
  // A valid hostname or token format cannot prove branch membership or bucket privacy.
  return Object.freeze({ mode, branch, host, storage });
}
