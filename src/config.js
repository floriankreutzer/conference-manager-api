import { ApiError } from './api-error.js';

const MODES = new Set(['development', 'test', 'pilot', 'production']);
const DATABASE_SSL_MODES = new Set(['disable', 'verify-full']);
const SUPPORT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_AUTHORITY = 'https://login.microsoftonline.com/organizations';
const ENTRA_CALLBACK_PATH = '/api/v1/auth/microsoft/callback';
const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 3000,
  maxBodyBytes: 65_536,
  maxResponseBytes: 1_048_576,
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  requestTimeoutMs: 15_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  readinessTimeoutMs: 1_000,
  databasePoolMax: 10,
  databaseConnectionTimeoutMs: 5_000,
  databaseIdleTimeoutMs: 30_000,
  databaseStatementTimeoutMs: 10_000,
  sessionTtlSeconds: 28_800,
  oidcTransactionTtlSeconds: 600,
  microsoft365ConsentTtlSeconds: 600,
  microsoft365GraphTimeoutMs: 10_000,
});

export class ConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConfigurationError';
    this.code = code;
  }
}

function parseInteger(value, fallback, { min, max, code }) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new ConfigurationError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ConfigurationError(code);
  return parsed;
}

function parseMode(env) {
  const mode = env.NODE_ENV || 'development';
  if (!MODES.has(mode)) throw new ConfigurationError('NODE_ENV_INVALID');
  return mode;
}

function parseSupportIdentifier(value, fallback, { requiredCode, invalidCode }) {
  const candidate = value || fallback;
  if (!candidate) throw new ConfigurationError(requiredCode);
  if (!SUPPORT_IDENTIFIER.test(candidate)) throw new ConfigurationError(invalidCode);
  return candidate;
}

function parseOrigin(value, mode) {
  const fallback = mode === 'development' || mode === 'test' ? 'http://localhost:3000' : null;
  const candidate = value || fallback;
  if (!candidate) throw new ConfigurationError('PUBLIC_ORIGIN_REQUIRED');

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ConfigurationError('PUBLIC_ORIGIN_INVALID');
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new ConfigurationError('PUBLIC_ORIGIN_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ConfigurationError('PUBLIC_ORIGIN_INVALID');
  if ((mode === 'pilot' || mode === 'production') && parsed.protocol !== 'https:') {
    throw new ConfigurationError('PUBLIC_ORIGIN_HTTPS_REQUIRED');
  }
  return parsed.origin;
}

function parseDatabaseUrl(value, mode) {
  if (!value) {
    if (mode === 'pilot' || mode === 'production') throw new ConfigurationError('DATABASE_URL_REQUIRED');
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError('DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new ConfigurationError('DATABASE_URL_INVALID');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/' || parsed.hash || parsed.search) {
    throw new ConfigurationError('DATABASE_URL_INVALID');
  }
  return value;
}

function parseDatabaseSsl(value, mode) {
  const fallback = mode === 'pilot' || mode === 'production' ? 'verify-full' : 'disable';
  const selected = value || fallback;
  if (!DATABASE_SSL_MODES.has(selected)) throw new ConfigurationError('DATABASE_SSL_INVALID');
  if ((mode === 'pilot' || mode === 'production') && selected !== 'verify-full') {
    throw new ConfigurationError('DATABASE_SSL_REQUIRED');
  }
  return selected;
}

function parseServerSecret(value, mode, { requiredCode, invalidCode }) {
  if (!value) {
    if (mode === 'pilot' || mode === 'production') throw new ConfigurationError(requiredCode);
    return null;
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 32 || bytes > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConfigurationError(invalidCode);
  }
  return value;
}

function parseEntraConfig(env, mode, publicOrigin) {
  const required = mode === 'pilot' || mode === 'production';
  const configured = Boolean(env.ENTRA_CLIENT_ID || env.ENTRA_CLIENT_SECRET || env.OIDC_TRANSACTION_SECRET);
  if (!required && !configured) {
    return Object.freeze({
      entraClientId: null,
      entraClientSecret: null,
      oidcTransactionSecret: null,
      entraAuthority: ENTRA_AUTHORITY,
      entraRedirectUri: new URL(ENTRA_CALLBACK_PATH, publicOrigin).toString(),
      oidcTransactionTtlSeconds: parseInteger(
        env.OIDC_TRANSACTION_TTL_SECONDS,
        DEFAULTS.oidcTransactionTtlSeconds,
        { min: 120, max: 900, code: 'OIDC_TRANSACTION_TTL_SECONDS_INVALID' },
      ),
    });
  }

  if (typeof env.ENTRA_CLIENT_ID !== 'string' || !GUID_PATTERN.test(env.ENTRA_CLIENT_ID)) {
    throw new ConfigurationError(env.ENTRA_CLIENT_ID ? 'ENTRA_CLIENT_ID_INVALID' : 'ENTRA_CLIENT_ID_REQUIRED');
  }
  const entraClientSecret = parseServerSecret(env.ENTRA_CLIENT_SECRET, 'production', {
    requiredCode: 'ENTRA_CLIENT_SECRET_REQUIRED',
    invalidCode: 'ENTRA_CLIENT_SECRET_INVALID',
  });
  const oidcTransactionSecret = parseServerSecret(env.OIDC_TRANSACTION_SECRET, 'production', {
    requiredCode: 'OIDC_TRANSACTION_SECRET_REQUIRED',
    invalidCode: 'OIDC_TRANSACTION_SECRET_INVALID',
  });

  return Object.freeze({
    entraClientId: env.ENTRA_CLIENT_ID.toLowerCase(),
    entraClientSecret,
    oidcTransactionSecret,
    entraAuthority: ENTRA_AUTHORITY,
    entraRedirectUri: new URL(ENTRA_CALLBACK_PATH, publicOrigin).toString(),
    oidcTransactionTtlSeconds: parseInteger(
      env.OIDC_TRANSACTION_TTL_SECONDS,
      DEFAULTS.oidcTransactionTtlSeconds,
      { min: 120, max: 900, code: 'OIDC_TRANSACTION_TTL_SECONDS_INVALID' },
    ),
  });
}

export function loadDatabaseConfig(env = process.env, mode = parseMode(env)) {
  return Object.freeze({
    databaseUrl: parseDatabaseUrl(env.DATABASE_URL, mode),
    databaseSsl: parseDatabaseSsl(env.DATABASE_SSL, mode),
    databasePoolMax: parseInteger(env.DATABASE_POOL_MAX, DEFAULTS.databasePoolMax, {
      min: 1,
      max: 50,
      code: 'DATABASE_POOL_MAX_INVALID',
    }),
    databaseConnectionTimeoutMs: parseInteger(
      env.DATABASE_CONNECTION_TIMEOUT_MS,
      DEFAULTS.databaseConnectionTimeoutMs,
      { min: 500, max: 30_000, code: 'DATABASE_CONNECTION_TIMEOUT_MS_INVALID' },
    ),
    databaseIdleTimeoutMs: parseInteger(env.DATABASE_IDLE_TIMEOUT_MS, DEFAULTS.databaseIdleTimeoutMs, {
      min: 1_000,
      max: 300_000,
      code: 'DATABASE_IDLE_TIMEOUT_MS_INVALID',
    }),
    databaseStatementTimeoutMs: parseInteger(
      env.DATABASE_STATEMENT_TIMEOUT_MS,
      DEFAULTS.databaseStatementTimeoutMs,
      { min: 500, max: 120_000, code: 'DATABASE_STATEMENT_TIMEOUT_MS_INVALID' },
    ),
  });
}

export function loadConfig(env = process.env) {
  const mode = parseMode(env);
  const supportFallback = mode === 'development' || mode === 'test';
  const publicOrigin = parseOrigin(env.PUBLIC_ORIGIN, mode);
  const database = loadDatabaseConfig(env, mode);
  const csrfSecret = parseServerSecret(env.CSRF_SECRET, mode, {
    requiredCode: 'CSRF_SECRET_REQUIRED',
    invalidCode: 'CSRF_SECRET_INVALID',
  });
  const auditHmacSecret = parseServerSecret(env.AUDIT_HMAC_SECRET, mode, {
    requiredCode: 'AUDIT_HMAC_SECRET_REQUIRED',
    invalidCode: 'AUDIT_HMAC_SECRET_INVALID',
  });
  if (database.databaseUrl && !auditHmacSecret) {
    throw new ConfigurationError('AUDIT_HMAC_SECRET_REQUIRED');
  }
  const entra = parseEntraConfig(env, mode, publicOrigin);

  return Object.freeze({
    mode,
    serviceVersion: parseSupportIdentifier(env.SERVICE_VERSION, supportFallback ? '0.1.0' : null, {
      requiredCode: 'SERVICE_VERSION_REQUIRED',
      invalidCode: 'SERVICE_VERSION_INVALID',
    }),
    buildId: parseSupportIdentifier(env.BUILD_ID, supportFallback ? 'local' : null, {
      requiredCode: 'BUILD_ID_REQUIRED',
      invalidCode: 'BUILD_ID_INVALID',
    }),
    publicOrigin,
    host: env.HOST || DEFAULTS.host,
    port: parseInteger(env.PORT, DEFAULTS.port, { min: 1, max: 65_535, code: 'PORT_INVALID' }),
    maxBodyBytes: parseInteger(env.MAX_BODY_BYTES, DEFAULTS.maxBodyBytes, {
      min: 1_024,
      max: 1_048_576,
      code: 'MAX_BODY_BYTES_INVALID',
    }),
    maxResponseBytes: parseInteger(env.MAX_RESPONSE_BYTES, DEFAULTS.maxResponseBytes, {
      min: 1_024,
      max: 4_194_304,
      code: 'MAX_RESPONSE_BYTES_INVALID',
    }),
    rateLimitMax: parseInteger(env.RATE_LIMIT_MAX, DEFAULTS.rateLimitMax, {
      min: 1,
      max: 10_000,
      code: 'RATE_LIMIT_MAX_INVALID',
    }),
    rateLimitWindowMs: parseInteger(env.RATE_LIMIT_WINDOW_MS, DEFAULTS.rateLimitWindowMs, {
      min: 1_000,
      max: 3_600_000,
      code: 'RATE_LIMIT_WINDOW_MS_INVALID',
    }),
    requestTimeoutMs: parseInteger(env.REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, {
      min: 1_000,
      max: 120_000,
      code: 'REQUEST_TIMEOUT_MS_INVALID',
    }),
    headersTimeoutMs: parseInteger(env.HEADERS_TIMEOUT_MS, DEFAULTS.headersTimeoutMs, {
      min: 1_000,
      max: 60_000,
      code: 'HEADERS_TIMEOUT_MS_INVALID',
    }),
    keepAliveTimeoutMs: parseInteger(env.KEEP_ALIVE_TIMEOUT_MS, DEFAULTS.keepAliveTimeoutMs, {
      min: 500,
      max: 60_000,
      code: 'KEEP_ALIVE_TIMEOUT_MS_INVALID',
    }),
    readinessTimeoutMs: parseInteger(env.READINESS_TIMEOUT_MS, DEFAULTS.readinessTimeoutMs, {
      min: 100,
      max: 10_000,
      code: 'READINESS_TIMEOUT_MS_INVALID',
    }),
    sessionTtlSeconds: parseInteger(env.SESSION_TTL_SECONDS, DEFAULTS.sessionTtlSeconds, {
      min: 300,
      max: 86_400,
      code: 'SESSION_TTL_SECONDS_INVALID',
    }),
    microsoft365ConsentTtlSeconds: parseInteger(
      env.MICROSOFT365_CONSENT_TTL_SECONDS,
      DEFAULTS.microsoft365ConsentTtlSeconds,
      { min: 120, max: 900, code: 'MICROSOFT365_CONSENT_TTL_SECONDS_INVALID' },
    ),
    microsoft365GraphTimeoutMs: parseInteger(
      env.MICROSOFT365_GRAPH_TIMEOUT_MS,
      DEFAULTS.microsoft365GraphTimeoutMs,
      { min: 1_000, max: 30_000, code: 'MICROSOFT365_GRAPH_TIMEOUT_MS_INVALID' },
    ),
    csrfSecret,
    auditHmacSecret,
    ...entra,
    ...database,
  });
}

export function assertProductionConfig(config) {
  if ((config.mode === 'pilot' || config.mode === 'production') && !config.publicOrigin.startsWith('https://')) {
    throw new ApiError(500, 'SECURE_CONFIGURATION_REQUIRED');
  }
  if ((config.mode === 'pilot' || config.mode === 'production') && !config.databaseUrl) {
    throw new ApiError(500, 'DATABASE_CONFIGURATION_REQUIRED');
  }
  if ((config.mode === 'pilot' || config.mode === 'production') && config.databaseSsl !== 'verify-full') {
    throw new ApiError(500, 'DATABASE_TLS_REQUIRED');
  }
  if ((config.mode === 'pilot' || config.mode === 'production') && !config.csrfSecret) {
    throw new ApiError(500, 'CSRF_SECRET_REQUIRED');
  }
  if (config.databaseUrl && !config.auditHmacSecret) {
    throw new ApiError(500, 'AUDIT_HMAC_SECRET_REQUIRED');
  }
  if ((config.mode === 'pilot' || config.mode === 'production') && !config.entraClientId) {
    throw new ApiError(500, 'ENTRA_CONFIGURATION_REQUIRED');
  }
  if ((config.mode === 'pilot' || config.mode === 'production') && !config.entraClientSecret) {
    throw new ApiError(500, 'ENTRA_CONFIGURATION_REQUIRED');
  }
  if ((config.mode === 'pilot' || config.mode === 'production') && !config.oidcTransactionSecret) {
    throw new ApiError(500, 'OIDC_CONFIGURATION_REQUIRED');
  }
}
