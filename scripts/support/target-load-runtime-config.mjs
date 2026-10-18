import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { loadPlatformConfig } from '../../src/platform/config.js';
import { mediaObjectReference } from '../../src/media/object-storage-contract.js';
import { createNeonBranchStorageConfig } from '../../src/media/neon-storage-config.js';
import { loadTargetOrigin, loadTargetScope } from './target-load-guard.mjs';

function valid(value) { if (!value) throw new Error('LOAD_RUNTIME_CONFIG_INVALID'); }
const secret = () => randomBytes(32).toString('base64url');

export function targetScopeValues(env) {
  return { runId: env.LOAD_RUN_ID, releaseSha: env.LOAD_RELEASE_SHA, surface: env.LOAD_SURFACE,
    createdAt: env.LOAD_CREATED_AT, expiresAt: env.LOAD_EXPIRES_AT, databaseUrl: env.LOAD_DATABASE_URL,
    expectedDatabaseHost: env.LOAD_DATABASE_HOST, observerToken: env.LOAD_OBSERVER_TOKEN,
    storageBucket: env.LOAD_STORAGE_BUCKET, serviceName: env.LOAD_SERVICE_NAME };
}

// An isolated target uses its own LOAD_* namespace. Never inherit a normal
// Customer, Platform or Demo connection or real identity/provider credential.
export function loadTargetRuntimeConfig(env, now = Date.now()) {
  try {
    valid(env && typeof env === 'object' && !Array.isArray(env));
    valid(env.LOAD_OPERATOR_MODE === undefined && env.LOAD_OPERATOR_TOKEN === undefined);
    const forbidden = /^(?:DEMO_|PLATFORM_|ENTRA_|MICROSOFT365_|OIDC_|CSRF_SECRET$|AUDIT_HMAC_SECRET$|DATABASE_URL$)/;
    valid(Object.keys(env).every(key => !forbidden.test(key)));
    const values = targetScopeValues(env); const scope = loadTargetScope(values, now);
    valid(scope.surface !== 'setup' && env.RENDER === 'true'
      && env.RENDER_GIT_REPO_SLUG === 'floriankreutzer/conference-manager-api'
      && env.RENDER_GIT_BRANCH === 'main' && env.RENDER_GIT_COMMIT === scope.releaseSha
      && env.RENDER_SERVICE_NAME === values.serviceName);
    const publicOrigin = loadTargetOrigin(env.LOAD_PUBLIC_ORIGIN, scope.runId, scope.surface);
    // The exact verified TLS option was validated above. The canonical loader
    // deliberately rejects query options and receives TLS separately, unchanged.
    const database = new URL(scope.databaseUrl); database.search = '';
    const profile = env.LOAD_RATE_PROFILE ?? 'canonical120';
    valid(['canonical120', 'representative1000'].includes(profile));
    const rateLimitMax = profile === 'canonical120' ? '120' : '1000';
    const port = env.PORT ?? '10000';
    const version = `saas38-load-${scope.runId}`;
    let config; let storageConfig = null; let storageProbe = null;
    if (scope.surface === 'customer') {
      valid(env.LOAD_CURSOR_SECRET === undefined && env.LOAD_TENANT_AUDIT_HMAC_SECRET === undefined);
      valid(typeof env.LOAD_STORAGE_PROBE_JSON === 'string' && Buffer.byteLength(env.LOAD_STORAGE_PROBE_JSON) <= 1024);
      const probe = JSON.parse(env.LOAD_STORAGE_PROBE_JSON);
      valid(probe && Object.keys(probe).length === 4
        && Object.keys(probe).every(key => ['tenantId', 'assetId', 'sha256', 'byteLength'].includes(key)));
      storageProbe = mediaObjectReference({ ...probe, kind: 'room', contentType: 'image/webp' });
      storageConfig = createNeonBranchStorageConfig({ branch: env.LOAD_STORAGE_BRANCH,
        bucket: scope.storageBucket, accessKeyId: env.LOAD_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: env.LOAD_STORAGE_SECRET_ACCESS_KEY });
      config = loadConfig({ NODE_ENV: 'production', HOST: '0.0.0.0', PORT: port,
        SERVICE_VERSION: version, BUILD_ID: scope.releaseSha, PUBLIC_ORIGIN: publicOrigin,
        DATABASE_URL: database.toString(), DATABASE_SSL: 'verify-full', DATABASE_POOL_MAX: '10',
        CSRF_SECRET: env.LOAD_CSRF_SECRET, AUDIT_HMAC_SECRET: env.LOAD_AUDIT_HMAC_SECRET,
        RATE_LIMIT_MAX: rateLimitMax, SESSION_TTL_SECONDS: '7200',
        // No identity client is composed. These satisfy the canonical secure
        // configuration schema without installing a real identity credential.
        ENTRA_CLIENT_ID: randomUUID(), ENTRA_CLIENT_SECRET: secret(), OIDC_TRANSACTION_SECRET: secret() });
    } else {
      valid(env.LOAD_STORAGE_PROBE_JSON === undefined && env.LOAD_STORAGE_BRANCH === undefined
        && env.LOAD_STORAGE_ACCESS_KEY_ID === undefined
        && env.LOAD_STORAGE_SECRET_ACCESS_KEY === undefined);
      const identityTenant = randomUUID();
      config = loadPlatformConfig({ NODE_ENV: 'production', PLATFORM_HOST: '0.0.0.0', PLATFORM_PORT: port,
        PLATFORM_SERVICE_VERSION: version, PLATFORM_BUILD_ID: scope.releaseSha, PLATFORM_PUBLIC_ORIGIN: publicOrigin,
        PLATFORM_DATABASE_URL: database.toString(), PLATFORM_DATABASE_SSL: 'verify-full', PLATFORM_DATABASE_POOL_MAX: '4',
        PLATFORM_CSRF_SECRET: env.LOAD_CSRF_SECRET, PLATFORM_AUDIT_HMAC_SECRET: env.LOAD_AUDIT_HMAC_SECRET,
        PLATFORM_CURSOR_SECRET: env.LOAD_CURSOR_SECRET, PLATFORM_TENANT_AUDIT_HMAC_SECRET: env.LOAD_TENANT_AUDIT_HMAC_SECRET,
        PLATFORM_RATE_LIMIT_MAX: rateLimitMax, PLATFORM_SESSION_TTL_SECONDS: '7200',
        PLATFORM_ENTRA_TENANT_ID: identityTenant, PLATFORM_ENTRA_CLIENT_ID: randomUUID(),
        PLATFORM_ENTRA_AUTHORITY: `https://login.microsoftonline.com/${identityTenant}`,
        PLATFORM_ENTRA_CLIENT_SECRET: secret(), PLATFORM_OIDC_TRANSACTION_SECRET: secret(),
        PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT: 'load-mfa', PLATFORM_ENTRA_STEP_UP_AUTHENTICATION_CONTEXT: 'load-stepup' });
    }
    return Object.freeze({ values: Object.freeze(values), scope, config, storageConfig, storageProbe, profile });
  } catch { throw new Error('LOAD_RUNTIME_CONFIG_INVALID'); }
}
