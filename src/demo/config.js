import {
  DEMO_DATABASE_SENTINEL_KEY,
  DEMO_RUNTIME,
  DEMO_SEED_VERSION,
} from './runtime-contract.js';

const DEMO_ENVIRONMENTS = new Set(['demo', 'test']);
const DATABASE_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const ADMIN_DATABASE_ROLES = new Set(['postgres', 'rds_superuser', 'cloudsqlsuperuser']);
const DATABASE_ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const SECRET_KEYS = Object.freeze([
  'DEMO_CUSTOMER_SESSION_SECRET',
  'DEMO_CUSTOMER_CSRF_SECRET',
  'DEMO_PLATFORM_SESSION_SECRET',
  'DEMO_PLATFORM_CSRF_SECRET',
  'DEMO_TENANT_AUDIT_HMAC_SECRET',
]);
const FORBIDDEN_PROVIDER_KEY = new RegExp([
  '^(?:(?:AZURE|ENTRA)_(?:AUTHORITY|CLIENT_ID|CLIENT_SECRET|TENANT_ID)',
  '|GRAPH_(?:CLIENT_ID|CLIENT_SECRET|TENANT_ID|URL)',
  '|MICROSOFT(?:365)?_(?:CLIENT_ID|CLIENT_SECRET|GRAPH_URL|TENANT_ID)',
  '|OIDC_(?:AUTHORITY|CLIENT_ID|CLIENT_SECRET|ISSUER|TENANT_ID|TRANSACTION_SECRET))$',
].join(''), 'i');
const FORBIDDEN_PRODUCTION_KEY = /^(?:DATABASE_URL|PUBLIC_ORIGIN|SESSION_SECRET|CSRF_SECRET|AUDIT_HMAC_SECRET|PLATFORM_)/;

export class DemoConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DemoConfigError';
    this.code = code;
  }
}

function fail(code) {
  throw new DemoConfigError(code);
}

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail(`DEMO_CONFIG_${key}_REQUIRED`);
  }
  return value;
}

function optionalBoundedInteger(env, key, defaultValue, { min, max, code }) {
  const value = env[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(code);
  return parsed;
}

function parseOrigin(env, key) {
  const value = required(env, key);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`DEMO_CONFIG_${key}_INVALID`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.origin !== value
  ) fail(`DEMO_CONFIG_${key}_INVALID`);
  return url.origin;
}

function decodeComponent(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(code);
  }
}

function parseDatabaseUrl(env, key) {
  const value = required(env, key);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`DEMO_CONFIG_${key}_INVALID`);
  }
  const role = decodeComponent(url.username, `DEMO_CONFIG_${key}_INVALID`);
  const password = decodeComponent(url.password, `DEMO_CONFIG_${key}_INVALID`);
  const database = decodeComponent(url.pathname.slice(1), `DEMO_CONFIG_${key}_INVALID`);
  if (
    !DATABASE_PROTOCOLS.has(url.protocol)
    || !url.hostname
    || !DATABASE_ROLE_PATTERN.test(role)
    || !password
    || url.pathname.split('/').length !== 2
    || !/^conference_manager_demo_[a-z0-9_]{1,48}$/.test(database)
    || url.search
    || url.hash
    || ADMIN_DATABASE_ROLES.has(role.toLowerCase())
  ) fail(`DEMO_CONFIG_${key}_INVALID`);
  return Object.freeze({
    url: value,
    role,
    password,
    target: Object.freeze({
      host: url.hostname.toLowerCase(),
      port: url.port || '5432',
      database,
    }),
  });
}

function sameTarget(left, right) {
  return left.host === right.host
    && left.port === right.port
    && left.database === right.database;
}

function assertNoRealProviderConfiguration(env) {
  for (const [key, value] of Object.entries(env)) {
    if ((value === undefined || value === '') || key.startsWith('DEMO_')) continue;
    if (FORBIDDEN_PROVIDER_KEY.test(key) || FORBIDDEN_PRODUCTION_KEY.test(key)) {
      fail('DEMO_CONFIG_PRODUCTION_CONFIGURATION_FORBIDDEN');
    }
  }
}

function parseSelectedSecrets(env, databaseConfigs, keys) {
  const secrets = keys.map((key) => [key, required(env, key)]);
  if (secrets.some(([, value]) => value.length < 32)) fail('DEMO_CONFIG_SECRET_TOO_SHORT');
  if (new Set(secrets.map(([, value]) => value)).size !== secrets.length) {
    fail('DEMO_CONFIG_SECRET_ALIAS_FORBIDDEN');
  }
  const databasePasswords = new Set(databaseConfigs.map(({ password }) => password));
  if (secrets.some(([, value]) => databasePasswords.has(value))) {
    fail('DEMO_CONFIG_SECRET_DATABASE_ALIAS_FORBIDDEN');
  }
  return Object.freeze(Object.fromEntries(secrets.map(([key, value]) => [
    key.slice(5).toLowerCase(),
    value,
  ])));
}

function parseSecrets(env, databaseConfigs) {
  return parseSelectedSecrets(env, databaseConfigs, SECRET_KEYS);
}

function commonEnvironment(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('DEMO_CONFIG_ENV_REQUIRED');
  const environment = required(env, 'NODE_ENV');
  if (!DEMO_ENVIRONMENTS.has(environment)) fail('DEMO_CONFIG_ENVIRONMENT_FORBIDDEN');
  if (required(env, 'DEMO_RUNTIME') !== DEMO_RUNTIME) fail('DEMO_CONFIG_RUNTIME_INVALID');
  if (required(env, 'DEMO_SEED_VERSION') !== DEMO_SEED_VERSION) fail('DEMO_CONFIG_SEED_VERSION_INVALID');
  assertNoRealProviderConfiguration(env);
  const databaseSsl = required(env, 'DEMO_DATABASE_SSL');
  if (environment === 'demo' ? databaseSsl !== 'verify-full' : !['verify-full', 'disable'].includes(databaseSsl)) {
    fail('DEMO_CONFIG_DATABASE_SSL_INVALID');
  }
  const rateLimitMax = optionalBoundedInteger(env, 'DEMO_RATE_LIMIT_MAX', 120, {
    min: 1,
    max: 10_000,
    code: 'DEMO_CONFIG_RATE_LIMIT_MAX_INVALID',
  });
  return Object.freeze({ environment, databaseSsl, rateLimitMax });
}

function rejectCredentials(env, forbidden) {
  if (forbidden.some((key) => env[key] !== undefined && env[key] !== '')) {
    fail('DEMO_CONFIG_EXCESS_CREDENTIAL_FORBIDDEN');
  }
}

export function loadDemoCustomerConfig(env) {
  const common = commonEnvironment(env);
  rejectCredentials(env, [
    'DEMO_PLATFORM_DATABASE_URL',
    'DEMO_RESET_DATABASE_URL',
    'DEMO_MIGRATION_DATABASE_URL',
    'DEMO_PLATFORM_SESSION_SECRET',
    'DEMO_PLATFORM_CSRF_SECRET',
  ]);
  const customer = parseDatabaseUrl(env, 'DEMO_CUSTOMER_DATABASE_URL');
  const customerOrigin = parseOrigin(env, 'DEMO_CUSTOMER_ORIGIN');
  const platformOrigin = parseOrigin(env, 'DEMO_PLATFORM_ORIGIN');
  if (customerOrigin === platformOrigin) fail('DEMO_CONFIG_ORIGIN_ALIAS_FORBIDDEN');
  return Object.freeze({
    ...common,
    runtime: DEMO_RUNTIME,
    seedVersion: DEMO_SEED_VERSION,
    databaseSentinelKey: DEMO_DATABASE_SENTINEL_KEY,
    origins: Object.freeze({ customer: customerOrigin, platform: platformOrigin }),
    databases: Object.freeze({ customer }),
    databaseTarget: customer.target,
    secrets: parseSelectedSecrets(env, [customer], [
      'DEMO_CUSTOMER_SESSION_SECRET',
      'DEMO_CUSTOMER_CSRF_SECRET',
      'DEMO_TENANT_AUDIT_HMAC_SECRET',
    ]),
  });
}

export function loadDemoPlatformConfig(env) {
  const common = commonEnvironment(env);
  rejectCredentials(env, [
    'DEMO_CUSTOMER_DATABASE_URL',
    'DEMO_MIGRATION_DATABASE_URL',
    'DEMO_CUSTOMER_SESSION_SECRET',
    'DEMO_CUSTOMER_CSRF_SECRET',
  ]);
  const platform = parseDatabaseUrl(env, 'DEMO_PLATFORM_DATABASE_URL');
  const reset = parseDatabaseUrl(env, 'DEMO_RESET_DATABASE_URL');
  if (!sameTarget(platform.target, reset.target)) fail('DEMO_CONFIG_DATABASE_TARGET_MISMATCH');
  if (
    platform.url === reset.url
    || platform.role === reset.role
    || platform.password === reset.password
  ) fail('DEMO_CONFIG_DATABASE_PRINCIPAL_ALIAS_FORBIDDEN');
  const customerOrigin = parseOrigin(env, 'DEMO_CUSTOMER_ORIGIN');
  const platformOrigin = parseOrigin(env, 'DEMO_PLATFORM_ORIGIN');
  if (customerOrigin === platformOrigin) fail('DEMO_CONFIG_ORIGIN_ALIAS_FORBIDDEN');
  return Object.freeze({
    ...common,
    runtime: DEMO_RUNTIME,
    seedVersion: DEMO_SEED_VERSION,
    databaseSentinelKey: DEMO_DATABASE_SENTINEL_KEY,
    origins: Object.freeze({ customer: customerOrigin, platform: platformOrigin }),
    databases: Object.freeze({ platform, reset }),
    databaseTarget: platform.target,
    secrets: parseSelectedSecrets(env, [platform, reset], [
      'DEMO_PLATFORM_SESSION_SECRET',
      'DEMO_PLATFORM_CSRF_SECRET',
      'DEMO_TENANT_AUDIT_HMAC_SECRET',
    ]),
  });
}

export function loadDemoConfig(env) {
  const common = commonEnvironment(env);

  const customerOrigin = parseOrigin(env, 'DEMO_CUSTOMER_ORIGIN');
  const platformOrigin = parseOrigin(env, 'DEMO_PLATFORM_ORIGIN');
  if (customerOrigin === platformOrigin) fail('DEMO_CONFIG_ORIGIN_ALIAS_FORBIDDEN');

  const customer = parseDatabaseUrl(env, 'DEMO_CUSTOMER_DATABASE_URL');
  const platform = parseDatabaseUrl(env, 'DEMO_PLATFORM_DATABASE_URL');
  const reset = parseDatabaseUrl(env, 'DEMO_RESET_DATABASE_URL');
  const migration = parseDatabaseUrl(env, 'DEMO_MIGRATION_DATABASE_URL');
  const databases = [customer, platform, reset, migration];
  if (
    !sameTarget(customer.target, platform.target)
    || !sameTarget(customer.target, reset.target)
    || !sameTarget(customer.target, migration.target)
  ) {
    fail('DEMO_CONFIG_DATABASE_TARGET_MISMATCH');
  }
  if (
    new Set(databases.map(({ url }) => url)).size !== databases.length
    || new Set(databases.map(({ role }) => role)).size !== databases.length
    || new Set(databases.map(({ password }) => password)).size !== databases.length
  ) fail('DEMO_CONFIG_DATABASE_PRINCIPAL_ALIAS_FORBIDDEN');

  return Object.freeze({
    ...common,
    runtime: DEMO_RUNTIME,
    seedVersion: DEMO_SEED_VERSION,
    databaseSentinelKey: DEMO_DATABASE_SENTINEL_KEY,
    origins: Object.freeze({ customer: customerOrigin, platform: platformOrigin }),
    databases: Object.freeze({ customer, platform, reset, migration }),
    databaseTarget: customer.target,
    secrets: parseSecrets(env, databases),
  });
}
