import { loadDemoMediaStorageConfig } from './media-storage-config.js';

const KEYS = ['DEMO_LIVE_METRICS_ENABLED', 'DEMO_LIVE_METRICS_BRANCH_ID',
  'DEMO_LIVE_METRICS_ACCESS_KEY_ID', 'DEMO_LIVE_METRICS_SECRET_ACCESS_KEY'];

// Separate read-only telemetry credentials must never switch authoritative media mode.
// Reuse the established branch/database/TLS/role/credential validator on an isolated map.
export function loadDailyLiveStorageConfig(env, { config, access } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.keys(env).some((key) => key.startsWith('DEMO_LIVE_METRICS_') && !KEYS.includes(key))
    || ![undefined, 'false', 'true'].includes(env.DEMO_LIVE_METRICS_ENABLED)) throw new TypeError('LIVE_METRICS_CONFIG_INVALID');
  if (env.DEMO_LIVE_METRICS_ENABLED !== 'true') {
    if (KEYS.slice(1).some((key) => env[key])) throw new TypeError('LIVE_METRICS_DISABLED_CREDENTIALS_FORBIDDEN');
    return null;
  }
  const mediaCredentials = ['CUSTOMER', 'RESET'].flatMap((scope) =>
    [`DEMO_${scope}_MEDIA_STORAGE_ACCESS_KEY_ID`, `DEMO_${scope}_MEDIA_STORAGE_SECRET_ACCESS_KEY`])
    .map((key) => env[key]).filter((value) => typeof value === 'string' && value.length > 0);
  if (mediaCredentials.some((value) => value === env.DEMO_LIVE_METRICS_ACCESS_KEY_ID
    || value === env.DEMO_LIVE_METRICS_SECRET_ACCESS_KEY)) throw new TypeError('LIVE_METRICS_MEDIA_CREDENTIAL_ALIAS_FORBIDDEN');
  if (access?.mode !== 'password') throw new TypeError('LIVE_METRICS_OWNER_REQUIRED');
  return loadDemoMediaStorageConfig({
    NODE_ENV: env.NODE_ENV, DEMO_DATABASE_SSL: env.DEMO_DATABASE_SSL,
    DEMO_PLATFORM_DATABASE_URL: env.DEMO_PLATFORM_DATABASE_URL, DEMO_RESET_DATABASE_URL: env.DEMO_RESET_DATABASE_URL,
    DEMO_MEDIA_STORAGE: 'neon', DEMO_MEDIA_STORAGE_BRANCH_ID: env.DEMO_LIVE_METRICS_BRANCH_ID,
    DEMO_MEDIA_STORAGE_DATABASE_HOST: config?.databaseTarget?.host,
    DEMO_RESET_MEDIA_STORAGE_ACCESS_KEY_ID: env.DEMO_LIVE_METRICS_ACCESS_KEY_ID,
    DEMO_RESET_MEDIA_STORAGE_SECRET_ACCESS_KEY: env.DEMO_LIVE_METRICS_SECRET_ACCESS_KEY,
  }, { config, surface: 'platform' }).storage;
}
