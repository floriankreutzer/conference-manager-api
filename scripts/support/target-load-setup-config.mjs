import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { createNeonBranchStorageConfig } from '../../src/media/neon-storage-config.js';
import { loadTargetOrigin, loadTargetScope } from './target-load-guard.mjs';
import { targetScopeValues } from './target-load-runtime-config.mjs';
import { loadTargetOperatorConfig } from './target-load-operator-config.mjs';

function valid(value) { if (!value) throw new Error('LOAD_SETUP_CONFIG_INVALID'); }

export function loadTargetSetupConfig(env, now = Date.now()) {
  try {
    valid(env && typeof env === 'object' && !Array.isArray(env));
    if (env.LOAD_OPERATOR_MODE !== undefined) loadTargetOperatorConfig(env, now);
    else valid(env.RENDER !== 'true' && env.LOAD_OPERATOR_TOKEN === undefined);
    const forbidden = /^(?:DEMO_|PLATFORM_|ENTRA_|MICROSOFT365_|OIDC_|CSRF_SECRET$|AUDIT_HMAC_SECRET$|DATABASE_URL$)/;
    valid(Object.keys(env).every(key => !forbidden.test(key)));
    const values = targetScopeValues(env); const scope = loadTargetScope(values, now);
    valid(scope.surface === 'setup' && scope.expiresMs - now >= 5 * 60_000
      && env.LOAD_STORAGE_PROBE_JSON === undefined && env.LOAD_CURSOR_SECRET === undefined
      && env.LOAD_TENANT_AUDIT_HMAC_SECRET === undefined);
    const populationValue = env.LOAD_FIXTURE_USERS ?? '100'; valid(['100', '1000', '10000'].includes(populationValue));
    const population = Number(populationValue);
    valid(typeof env.LOAD_CSRF_SECRET === 'string' && Buffer.byteLength(env.LOAD_CSRF_SECRET) >= 32);
    const database = new URL(scope.databaseUrl); database.search = '';
    const storageConfig = createNeonBranchStorageConfig({ branch: env.LOAD_STORAGE_BRANCH,
      bucket: scope.storageBucket, accessKeyId: env.LOAD_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.LOAD_STORAGE_SECRET_ACCESS_KEY });
    const config = { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
      DATABASE_URL: database.toString(), DATABASE_SSL: 'verify-full', DATABASE_POOL_MAX: '2',
      CSRF_SECRET: env.LOAD_CSRF_SECRET, AUDIT_HMAC_SECRET: env.LOAD_AUDIT_HMAC_SECRET,
      // Canonical onboarding composition requires a transaction secret even
      // when no identity client exists. No real provider credential is installed.
      ENTRA_CLIENT_ID: randomUUID(), ENTRA_CLIENT_SECRET: randomBytes(32).toString('base64url'),
      OIDC_TRANSACTION_SECRET: randomBytes(32).toString('base64url'),
      SERVICE_VERSION: `saas38-load-${scope.runId}`, BUILD_ID: scope.releaseSha }), host: '127.0.0.1', port: 0 };
    const origins = Object.fromEntries(['customer', 'platform'].map(surface => [surface,
      loadTargetOrigin(`https://cm-saas38-load-${scope.runId}-${surface}.onrender.com`, scope.runId, surface)]));
    return { scope, values: Object.freeze(values), config, storageConfig, origins, population };
  } catch { throw new Error('LOAD_SETUP_CONFIG_INVALID'); }
}
