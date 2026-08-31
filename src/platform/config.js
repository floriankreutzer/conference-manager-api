const MODES = new Set(['development', 'test', 'pilot', 'production']);
const HTTP_MODES = new Set([...MODES, 'demo']);
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const AUTHENTICATION_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BIND_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const DATABASE_SSL_MODES = new Set(['disable', 'verify-full']);
const CALLBACK_PATH = '/api/v1/platform/auth/microsoft/callback';
const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 3100,
  maxBodyBytes: 65_536,
  maxResponseBytes: 1_048_576,
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  rateLimitMaxKeys: 10_000,
  requestTimeoutMs: 15_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  readinessTimeoutMs: 1_000,
  databasePoolMax: 10,
  databaseConnectionTimeoutMs: 5_000,
  databaseIdleTimeoutMs: 30_000,
  databaseStatementTimeoutMs: 10_000,
  sessionTtlSeconds: 14_400,
  stepUpTtlSeconds: 300,
  authenticationMaxAgeSeconds: 900,
  oidcTransactionTtlSeconds: 600,
  securityEpoch: 1,
});

export class PlatformConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PlatformConfigurationError';
    this.code = code;
  }
}

function fail(code) {
  throw new PlatformConfigurationError(code);
}

function parseMode(env) {
  const mode = env.NODE_ENV || 'development';
  if (!MODES.has(mode)) fail('PLATFORM_NODE_ENV_INVALID');
  return mode;
}

function parseInteger(value, fallback, { min, max, code }) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(code);
  return parsed;
}

function parseIdentifier(value, fallback, code) {
  const candidate = value || fallback;
  if (!candidate || !SUPPORT_IDENTIFIER.test(candidate)) fail(code);
  return candidate;
}

function parseOrigin(value) {
  if (!value) fail('PLATFORM_PUBLIC_ORIGIN_REQUIRED');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('PLATFORM_PUBLIC_ORIGIN_INVALID');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.origin !== value
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) fail('PLATFORM_PUBLIC_ORIGIN_INVALID');
  return parsed.origin;
}

function parseGuid(value, { required, requiredCode, invalidCode }) {
  if (!value) {
    if (required) fail(requiredCode);
    return null;
  }
  if (!GUID_PATTERN.test(value)) fail(invalidCode);
  return value.toLowerCase();
}

function parseSecret(value, { required, requiredCode, invalidCode }) {
  if (!value) {
    if (required) fail(requiredCode);
    return null;
  }
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 32
    || Buffer.byteLength(value, 'utf8') > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) fail(invalidCode);
  return value;
}

function parseDatabaseUrl(value, { required }) {
  if (!value) {
    if (required) fail('PLATFORM_DATABASE_URL_REQUIRED');
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('PLATFORM_DATABASE_URL_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.pathname === '/'
    || parsed.hash
  ) fail('PLATFORM_DATABASE_URL_INVALID');
  return value;
}

function parseDatabaseSsl(value, mode) {
  const selected = value || ((mode === 'pilot' || mode === 'production') ? 'verify-full' : 'disable');
  if (!DATABASE_SSL_MODES.has(selected)) fail('PLATFORM_DATABASE_SSL_INVALID');
  if ((mode === 'pilot' || mode === 'production') && selected !== 'verify-full') {
    fail('PLATFORM_DATABASE_SSL_REQUIRED');
  }
  return selected;
}

function parseAuthenticationContext(value, { required, code }) {
  if (!value) {
    if (required) fail(code);
    return null;
  }
  if (!AUTHENTICATION_CONTEXT.test(value)) fail(code);
  return value;
}

function parseAuthority(value, tenantId, { required }) {
  if (!value) {
    if (required) fail('PLATFORM_ENTRA_AUTHORITY_REQUIRED');
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('PLATFORM_ENTRA_AUTHORITY_INVALID');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'login.microsoftonline.com'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname.replace(/\/$/, '').toLowerCase() !== `/${tenantId}`
    || parsed.search !== ''
    || parsed.hash !== ''
  ) fail('PLATFORM_ENTRA_AUTHORITY_INVALID');
  return parsed.toString().replace(/\/$/, '');
}

function rejectAlias(platformValue, customerValue, code) {
  if (platformValue !== null && platformValue !== undefined && platformValue === customerValue) fail(code);
}

export function loadPlatformConfig(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('PLATFORM_ENV_REQUIRED');
  const mode = parseMode(env);
  const productionLike = mode === 'pilot' || mode === 'production';
  const publicOrigin = parseOrigin(env.PLATFORM_PUBLIC_ORIGIN);
  const anyIdentityConfiguration = Boolean(
    env.PLATFORM_ENTRA_TENANT_ID
    || env.PLATFORM_ENTRA_CLIENT_ID
    || env.PLATFORM_ENTRA_CLIENT_SECRET
    || env.PLATFORM_ENTRA_AUTHORITY
    || env.PLATFORM_OIDC_TRANSACTION_SECRET
  );
  const identityRequired = productionLike || anyIdentityConfiguration;
  const tenantId = parseGuid(env.PLATFORM_ENTRA_TENANT_ID, {
    required: identityRequired,
    requiredCode: 'PLATFORM_ENTRA_TENANT_ID_REQUIRED',
    invalidCode: 'PLATFORM_ENTRA_TENANT_ID_INVALID',
  });
  const clientId = parseGuid(env.PLATFORM_ENTRA_CLIENT_ID, {
    required: identityRequired,
    requiredCode: 'PLATFORM_ENTRA_CLIENT_ID_REQUIRED',
    invalidCode: 'PLATFORM_ENTRA_CLIENT_ID_INVALID',
  });
  const clientSecret = parseSecret(env.PLATFORM_ENTRA_CLIENT_SECRET, {
    required: identityRequired,
    requiredCode: 'PLATFORM_ENTRA_CLIENT_SECRET_REQUIRED',
    invalidCode: 'PLATFORM_ENTRA_CLIENT_SECRET_INVALID',
  });
  const oidcTransactionSecret = parseSecret(env.PLATFORM_OIDC_TRANSACTION_SECRET, {
    required: identityRequired,
    requiredCode: 'PLATFORM_OIDC_TRANSACTION_SECRET_REQUIRED',
    invalidCode: 'PLATFORM_OIDC_TRANSACTION_SECRET_INVALID',
  });
  const csrfSecret = parseSecret(env.PLATFORM_CSRF_SECRET, {
    required: productionLike,
    requiredCode: 'PLATFORM_CSRF_SECRET_REQUIRED',
    invalidCode: 'PLATFORM_CSRF_SECRET_INVALID',
  });
  const auditHmacSecret = parseSecret(env.PLATFORM_AUDIT_HMAC_SECRET, {
    required: productionLike,
    requiredCode: 'PLATFORM_AUDIT_HMAC_SECRET_REQUIRED',
    invalidCode: 'PLATFORM_AUDIT_HMAC_SECRET_INVALID',
  });
  const cursorSecret = parseSecret(env.PLATFORM_CURSOR_SECRET, {
    required: productionLike,
    requiredCode: 'PLATFORM_CURSOR_SECRET_REQUIRED',
    invalidCode: 'PLATFORM_CURSOR_SECRET_INVALID',
  });
  const tenantAuditHmacSecret = parseSecret(env.PLATFORM_TENANT_AUDIT_HMAC_SECRET, {
    required: productionLike,
    requiredCode: 'PLATFORM_TENANT_AUDIT_HMAC_SECRET_REQUIRED',
    invalidCode: 'PLATFORM_TENANT_AUDIT_HMAC_SECRET_INVALID',
  });
  const mfaAuthenticationContext = parseAuthenticationContext(
    env.PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT,
    { required: identityRequired, code: 'PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT_INVALID' },
  );
  const stepUpAuthenticationContext = parseAuthenticationContext(
    env.PLATFORM_ENTRA_STEP_UP_AUTHENTICATION_CONTEXT,
    { required: identityRequired, code: 'PLATFORM_ENTRA_STEP_UP_AUTHENTICATION_CONTEXT_INVALID' },
  );
  if (
    mfaAuthenticationContext !== null
    && mfaAuthenticationContext === stepUpAuthenticationContext
  ) fail('PLATFORM_ENTRA_AUTHENTICATION_CONTEXTS_NOT_DISTINCT');
  const databaseUrl = parseDatabaseUrl(env.PLATFORM_DATABASE_URL, { required: productionLike });
  if (databaseUrl && (!auditHmacSecret || !cursorSecret || !tenantAuditHmacSecret)) {
    fail('PLATFORM_PERSISTENCE_SECRETS_REQUIRED');
  }

  rejectAlias(publicOrigin, env.PUBLIC_ORIGIN, 'PLATFORM_PUBLIC_ORIGIN_ALIAS_FORBIDDEN');
  rejectAlias(clientId, env.ENTRA_CLIENT_ID?.toLowerCase(), 'PLATFORM_ENTRA_CLIENT_ALIAS_FORBIDDEN');
  rejectAlias(clientSecret, env.ENTRA_CLIENT_SECRET, 'PLATFORM_ENTRA_SECRET_ALIAS_FORBIDDEN');
  rejectAlias(oidcTransactionSecret, env.OIDC_TRANSACTION_SECRET, 'PLATFORM_OIDC_SECRET_ALIAS_FORBIDDEN');
  rejectAlias(csrfSecret, env.CSRF_SECRET, 'PLATFORM_CSRF_SECRET_ALIAS_FORBIDDEN');
  rejectAlias(auditHmacSecret, env.AUDIT_HMAC_SECRET, 'PLATFORM_AUDIT_SECRET_ALIAS_FORBIDDEN');
  rejectAlias(
    tenantAuditHmacSecret,
    env.AUDIT_HMAC_SECRET,
    'PLATFORM_TENANT_AUDIT_SECRET_ALIAS_FORBIDDEN',
  );
  rejectAlias(
    tenantAuditHmacSecret,
    auditHmacSecret,
    'PLATFORM_AUDIT_DOMAIN_SECRET_ALIAS_FORBIDDEN',
  );
  rejectAlias(databaseUrl, env.DATABASE_URL, 'PLATFORM_DATABASE_CREDENTIAL_ALIAS_FORBIDDEN');

  const authority = parseAuthority(env.PLATFORM_ENTRA_AUTHORITY, tenantId, { required: identityRequired });
  const supportFallback = mode === 'development' || mode === 'test';
  return Object.freeze({
    mode,
    identityMode: 'microsoft_entra',
    serviceVersion: parseIdentifier(
      env.PLATFORM_SERVICE_VERSION,
      supportFallback ? '0.1.0' : null,
      'PLATFORM_SERVICE_VERSION_INVALID',
    ),
    buildId: parseIdentifier(
      env.PLATFORM_BUILD_ID,
      supportFallback ? 'local' : null,
      'PLATFORM_BUILD_ID_INVALID',
    ),
    publicOrigin,
    host: BIND_HOST.test(env.PLATFORM_HOST || DEFAULTS.host)
      ? env.PLATFORM_HOST || DEFAULTS.host
      : fail('PLATFORM_HOST_INVALID'),
    port: parseInteger(env.PLATFORM_PORT, DEFAULTS.port, {
      min: 1,
      max: 65_535,
      code: 'PLATFORM_PORT_INVALID',
    }),
    maxBodyBytes: parseInteger(env.PLATFORM_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes, {
      min: 1_024,
      max: 1_048_576,
      code: 'PLATFORM_MAX_BODY_BYTES_INVALID',
    }),
    maxResponseBytes: parseInteger(env.PLATFORM_MAX_RESPONSE_BYTES, DEFAULTS.maxResponseBytes, {
      min: 4_096,
      max: 4_194_304,
      code: 'PLATFORM_MAX_RESPONSE_BYTES_INVALID',
    }),
    rateLimitMax: parseInteger(env.PLATFORM_RATE_LIMIT_MAX, DEFAULTS.rateLimitMax, {
      min: 1,
      max: 10_000,
      code: 'PLATFORM_RATE_LIMIT_MAX_INVALID',
    }),
    rateLimitWindowMs: parseInteger(
      env.PLATFORM_RATE_LIMIT_WINDOW_MS,
      DEFAULTS.rateLimitWindowMs,
      { min: 1_000, max: 3_600_000, code: 'PLATFORM_RATE_LIMIT_WINDOW_INVALID' },
    ),
    rateLimitMaxKeys: parseInteger(env.PLATFORM_RATE_LIMIT_MAX_KEYS, DEFAULTS.rateLimitMaxKeys, {
      min: 1,
      max: 100_000,
      code: 'PLATFORM_RATE_LIMIT_KEY_BOUND_INVALID',
    }),
    requestTimeoutMs: parseInteger(env.PLATFORM_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, {
      min: 1_000,
      max: 120_000,
      code: 'PLATFORM_REQUEST_TIMEOUT_INVALID',
    }),
    headersTimeoutMs: parseInteger(env.PLATFORM_HEADERS_TIMEOUT_MS, DEFAULTS.headersTimeoutMs, {
      min: 1_000,
      max: 60_000,
      code: 'PLATFORM_HEADERS_TIMEOUT_INVALID',
    }),
    keepAliveTimeoutMs: parseInteger(env.PLATFORM_KEEP_ALIVE_TIMEOUT_MS, DEFAULTS.keepAliveTimeoutMs, {
      min: 500,
      max: 60_000,
      code: 'PLATFORM_KEEP_ALIVE_TIMEOUT_INVALID',
    }),
    readinessTimeoutMs: parseInteger(
      env.PLATFORM_READINESS_TIMEOUT_MS,
      DEFAULTS.readinessTimeoutMs,
      { min: 100, max: 10_000, code: 'PLATFORM_READINESS_TIMEOUT_INVALID' },
    ),
    sessionTtlSeconds: parseInteger(env.PLATFORM_SESSION_TTL_SECONDS, DEFAULTS.sessionTtlSeconds, {
      min: 300,
      max: 14_400,
      code: 'PLATFORM_SESSION_TTL_INVALID',
    }),
    stepUpTtlSeconds: parseInteger(env.PLATFORM_STEP_UP_TTL_SECONDS, DEFAULTS.stepUpTtlSeconds, {
      min: 60,
      max: 300,
      code: 'PLATFORM_STEP_UP_TTL_INVALID',
    }),
    authenticationMaxAgeSeconds: parseInteger(
      env.PLATFORM_AUTHENTICATION_MAX_AGE_SECONDS,
      DEFAULTS.authenticationMaxAgeSeconds,
      { min: 60, max: 1_800, code: 'PLATFORM_AUTHENTICATION_MAX_AGE_INVALID' },
    ),
    oidcTransactionTtlSeconds: parseInteger(
      env.PLATFORM_OIDC_TRANSACTION_TTL_SECONDS,
      DEFAULTS.oidcTransactionTtlSeconds,
      { min: 120, max: 600, code: 'PLATFORM_OIDC_TRANSACTION_TTL_INVALID' },
    ),
    securityEpoch: parseInteger(env.PLATFORM_SECURITY_EPOCH, DEFAULTS.securityEpoch, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      code: 'PLATFORM_SECURITY_EPOCH_INVALID',
    }),
    entraTenantId: tenantId,
    entraClientId: clientId,
    entraClientSecret: clientSecret,
    entraAuthority: authority,
    entraRedirectUri: new URL(CALLBACK_PATH, publicOrigin).toString(),
    mfaAuthenticationContext,
    stepUpAuthenticationContext,
    oidcTransactionSecret,
    csrfSecret,
    auditHmacSecret,
    cursorSecret,
    tenantAuditHmacSecret,
    databaseUrl,
    databaseSsl: parseDatabaseSsl(env.PLATFORM_DATABASE_SSL, mode),
    databasePoolMax: parseInteger(env.PLATFORM_DATABASE_POOL_MAX, DEFAULTS.databasePoolMax, {
      min: 1,
      max: 50,
      code: 'PLATFORM_DATABASE_POOL_MAX_INVALID',
    }),
    databaseConnectionTimeoutMs: parseInteger(
      env.PLATFORM_DATABASE_CONNECTION_TIMEOUT_MS,
      DEFAULTS.databaseConnectionTimeoutMs,
      { min: 500, max: 30_000, code: 'PLATFORM_DATABASE_CONNECTION_TIMEOUT_INVALID' },
    ),
    databaseIdleTimeoutMs: parseInteger(
      env.PLATFORM_DATABASE_IDLE_TIMEOUT_MS,
      DEFAULTS.databaseIdleTimeoutMs,
      { min: 1_000, max: 300_000, code: 'PLATFORM_DATABASE_IDLE_TIMEOUT_INVALID' },
    ),
    databaseStatementTimeoutMs: parseInteger(
      env.PLATFORM_DATABASE_STATEMENT_TIMEOUT_MS,
      DEFAULTS.databaseStatementTimeoutMs,
      { min: 500, max: 120_000, code: 'PLATFORM_DATABASE_STATEMENT_TIMEOUT_INVALID' },
    ),
    applicationName: 'conference-manager-platform-api',
  });
}

export function assertPlatformHttpConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('PLATFORM_CONFIG_REQUIRED');
  }
  parseOrigin(config.publicOrigin);
  if (!HTTP_MODES.has(config.mode)) throw new TypeError('PLATFORM_MODE_INVALID');
  for (const [value, minimum, maximum, code] of [
    [config.maxBodyBytes, 1_024, 1_048_576, 'PLATFORM_MAX_BODY_BYTES_INVALID'],
    [config.maxResponseBytes, 4_096, 4_194_304, 'PLATFORM_MAX_RESPONSE_BYTES_INVALID'],
    [config.rateLimitMax, 1, 10_000, 'PLATFORM_RATE_LIMIT_MAX_INVALID'],
    [config.rateLimitWindowMs, 1_000, 3_600_000, 'PLATFORM_RATE_LIMIT_WINDOW_INVALID'],
    [config.rateLimitMaxKeys, 1, 100_000, 'PLATFORM_RATE_LIMIT_KEY_BOUND_INVALID'],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(code);
  }
  const identityMode = config.identityMode || 'microsoft_entra';
  if (identityMode === 'microsoft_entra') {
    if (!config.entraAuthority || !config.entraClientId || !config.entraRedirectUri) {
      throw new TypeError('PLATFORM_ENTRA_HTTP_CONFIG_REQUIRED');
    }
  } else if (identityMode === 'demo') {
    if (
      config.demoRuntime !== true
      || config.mode === 'pilot'
      || config.mode === 'production'
      || config.entraAuthority !== null
      || config.entraClientId !== null
      || config.entraRedirectUri !== null
    ) throw new TypeError('PLATFORM_DEMO_HTTP_CONFIG_INVALID');
  } else {
    throw new TypeError('PLATFORM_IDENTITY_MODE_INVALID');
  }
  return config;
}
