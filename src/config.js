import { ApiError } from './api-error.js';

const MODES = new Set(['development', 'test', 'pilot', 'production']);
const DATABASE_SSL_MODES = new Set(['disable', 'verify-full']);
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

export function loadConfig(env = process.env) {
  const mode = env.NODE_ENV || 'development';
  if (!MODES.has(mode)) throw new ConfigurationError('NODE_ENV_INVALID');

  return Object.freeze({
    mode,
    publicOrigin: parseOrigin(env.PUBLIC_ORIGIN, mode),
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
}
