import { loadDatabaseConfig } from '../config.js';
import { resolveDeploymentEnvironment } from '../deployment-environment.js';

function invalid(stage) {
  const error = new TypeError('PLATFORM_PASSKEY_OFFLINE_CONFIGURATION_INVALID');
  error.stage = stage;
  throw error;
}
export function loadPlatformPasskeyOfflineConfig(env = {}) {
  // DEV/PROD remain prepared only until the first-customer environment cutover.
  if (env.NODE_ENV !== 'pilot' || resolveDeploymentEnvironment(env.DEPLOYMENT_ENVIRONMENT, 'pilot') !== 'int') invalid('MODE');
  const databaseUrl = env.PLATFORM_PASSKEY_OFFLINE_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || !databaseUrl || databaseUrl === env.PLATFORM_DATABASE_URL
    || databaseUrl === env.DATABASE_URL || !/^[a-z][a-z0-9_]{2,62}$/.test(env.PLATFORM_PASSKEY_OFFLINE_ROLE || '')) invalid('OWNER_CONFIGURATION');
  let offline; let runtime;
  try { offline = new URL(databaseUrl); runtime = new URL(env.PLATFORM_DATABASE_URL); } catch { invalid('DATABASE_URL'); }
  if (offline.protocol !== runtime.protocol || offline.host !== runtime.host || offline.pathname !== runtime.pathname
    || decodeURIComponent(offline.username) !== env.PLATFORM_PASSKEY_OFFLINE_ROLE
    || decodeURIComponent(runtime.username) === env.PLATFORM_PASSKEY_OFFLINE_ROLE) invalid('DATABASE_BINDING');
  const securityEpoch = Number(env.PLATFORM_SECURITY_EPOCH);
  if (!/^[1-9][0-9]*$/.test(env.PLATFORM_SECURITY_EPOCH || '') || !Number.isSafeInteger(securityEpoch)) invalid('SECURITY_REVISION');
  const auditHmacSecret = env.PLATFORM_AUDIT_HMAC_SECRET;
  if (typeof auditHmacSecret !== 'string' || Buffer.byteLength(auditHmacSecret) < 32 || Buffer.byteLength(auditHmacSecret) > 512
    || auditHmacSecret === env.AUDIT_HMAC_SECRET) invalid('SIGNING_KEY');
  return Object.freeze({ mode: 'pilot', environment: 'int', securityEpoch, auditHmacSecret,
    expectedOfflineRole: env.PLATFORM_PASSKEY_OFFLINE_ROLE,
    ...loadDatabaseConfig({ ...env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'verify-full', DATABASE_POOL_MAX: '1',
      DATABASE_CONNECTION_TIMEOUT_MS: '5000', DATABASE_STATEMENT_TIMEOUT_MS: '10000' }, 'pilot') });
}
