import { createHmac } from 'node:crypto';

const CUSTOMER_DEFAULTS = Object.freeze({ host: '127.0.0.1', port: 3000 });
const PLATFORM_DEFAULTS = Object.freeze({ host: '127.0.0.1', port: 3100 });
const DEMO_RESET_DATABASE_STATEMENT_TIMEOUT_MS = 60_000;
const DEMO_PLATFORM_PROJECTION_INTERVAL_MS = 15 * 60_000;

function derivedSecret(secret, purpose) {
  return createHmac('sha256', secret)
    .update(`conference-manager:demo:${purpose}:v1`, 'utf8')
    .digest('hex');
}

function common(config, surface, defaults) {
  if (!config || config.runtime !== 'shared-postgres-v1') {
    throw new TypeError('DEMO_RUNTIME_CONFIG_REQUIRED');
  }
  const database = config.databases?.[surface];
  if (!database?.url) throw new TypeError('DEMO_RUNTIME_DATABASE_REQUIRED');
  return {
    mode: 'demo',
    demoRuntime: true,
    serviceVersion: '0.1.0-demo',
    buildId: config.seedVersion,
    publicOrigin: config.origins[surface],
    host: config.listen?.host || defaults.host,
    port: config.listen?.port || defaults.port,
    staticRoot: config.staticRoot || null,
    maxBodyBytes: 65_536,
    maxResponseBytes: 1_048_576,
    rateLimitMax: config.rateLimitMax ?? 120,
    rateLimitWindowMs: 60_000,
    requestTimeoutMs: 15_000,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000,
    readinessTimeoutMs: 1_000,
    databaseUrl: database.url,
    databaseSsl: config.databaseSsl,
    databasePoolMax: 10,
    databaseConnectionTimeoutMs: 5_000,
    databaseIdleTimeoutMs: 30_000,
    databaseStatementTimeoutMs: 10_000,
  };
}

export function createDemoCustomerRuntimeConfig(config) {
  const shared = common(config, 'customer', CUSTOMER_DEFAULTS);
  const sessionSecret = config.secrets?.customer_session_secret;
  const csrfSecret = config.secrets?.customer_csrf_secret;
  const tenantAuditHmacSecret = config.secrets?.tenant_audit_hmac_secret;
  if (!sessionSecret || !csrfSecret || !tenantAuditHmacSecret) {
    throw new TypeError('DEMO_CUSTOMER_SECRETS_REQUIRED');
  }
  return Object.freeze({
    ...shared,
    applicationName: 'conference-manager-api',
    sessionTtlSeconds: 28_800,
    oidcTransactionTtlSeconds: 600,
    microsoft365ConsentTtlSeconds: 600,
    microsoft365GraphTimeoutMs: 10_000,
    csrfSecret,
    auditHmacSecret: tenantAuditHmacSecret,
    oidcTransactionSecret: derivedSecret(sessionSecret, 'customer-oidc-unused'),
    entraClientId: null,
    entraClientSecret: null,
    entraAuthority: null,
    entraRedirectUri: null,
  });
}

export function createDemoPlatformRuntimeConfig(config) {
  const shared = common(config, 'platform', PLATFORM_DEFAULTS);
  const sessionSecret = config.secrets?.platform_session_secret;
  const csrfSecret = config.secrets?.platform_csrf_secret;
  const tenantAuditHmacSecret = config.secrets?.tenant_audit_hmac_secret;
  if (!sessionSecret || !csrfSecret || !tenantAuditHmacSecret) {
    throw new TypeError('DEMO_PLATFORM_SECRETS_REQUIRED');
  }
  return Object.freeze({
    ...shared,
    applicationName: 'conference-manager-platform-api',
    identityMode: 'demo',
    rateLimitMaxKeys: 10_000,
    sessionTtlSeconds: 14_400,
    stepUpTtlSeconds: 300,
    authenticationMaxAgeSeconds: 900,
    oidcTransactionTtlSeconds: 600,
    securityEpoch: 1,
    entraTenantId: null,
    entraClientId: null,
    entraClientSecret: null,
    entraAuthority: null,
    entraRedirectUri: null,
    mfaAuthenticationContext: null,
    stepUpAuthenticationContext: null,
    oidcTransactionSecret: null,
    csrfSecret,
    auditHmacSecret: derivedSecret(sessionSecret, 'platform-audit'),
    cursorSecret: derivedSecret(sessionSecret, 'platform-cursor'),
    tenantAuditHmacSecret,
    resetDatabaseStatementTimeoutMs: DEMO_RESET_DATABASE_STATEMENT_TIMEOUT_MS,
    projectionIntervalMs: DEMO_PLATFORM_PROJECTION_INTERVAL_MS,
  });
}
