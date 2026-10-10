import { DemoConfigError } from './config.js';

const MODES = new Set(['open', 'closed', 'acceptance']);
const TOKEN_KEYS = Object.freeze({ customer: 'DEMO_CUSTOMER_ACCEPTANCE_TOKEN',
  platform: 'DEMO_PLATFORM_ACCEPTANCE_TOKEN' });
const EXPIRY_KEY = 'DEMO_TRAFFIC_ACCEPTANCE_EXPIRES_AT';
// Hosted acceptance retains its 80-minute job and 70-minute destructive reserve.
// This independent traffic deadline never changes recovery marker/provider TTLs.
const MAX_WINDOW_MS = 90 * 60_000;
const ALLOWED_KEYS = new Set(['DEMO_TRAFFIC_MODE', EXPIRY_KEY]);

function fail(code) { throw new DemoConfigError(code); }
function occupied(value) { return value !== undefined && value !== ''; }

export function loadDemoTrafficGateConfig(env, { config, surface, now = Date.now() } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || !TOKEN_KEYS[surface]
    || config?.runtime !== 'shared-postgres-v1' || !Number.isFinite(now)) {
    fail('DEMO_TRAFFIC_CONTEXT_INVALID');
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('DEMO_TRAFFIC_') && !ALLOWED_KEYS.has(key) && occupied(value)) {
      fail('DEMO_TRAFFIC_CONFIGURATION_INVALID');
    }
  }
  const mode = env.DEMO_TRAFFIC_MODE ?? 'open';
  if (!MODES.has(mode)) fail('DEMO_TRAFFIC_MODE_INVALID');
  const other = surface === 'customer' ? 'platform' : 'customer';
  if (occupied(env[TOKEN_KEYS[other]])) fail('DEMO_TRAFFIC_EXCESS_CREDENTIAL_FORBIDDEN');
  const token = env[TOKEN_KEYS[surface]];
  const expiry = env[EXPIRY_KEY];
  if (mode !== 'acceptance') {
    if (occupied(token) || occupied(expiry)) fail('DEMO_TRAFFIC_UNUSED_CONFIGURATION_FORBIDDEN');
    return Object.freeze({ mode, token: null, expiresAt: null });
  }
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    fail('DEMO_TRAFFIC_ACCEPTANCE_TOKEN_INVALID');
  }
  const secrets = [...Object.values(config.secrets || {}),
    ...Object.values(config.databases || {}).map(({ password }) => password),
    ...Object.entries(env).filter(([key]) => /MEDIA_STORAGE.*(?:ACCESS_KEY|SECRET)/.test(key))
      .map(([, value]) => value)];
  if (secrets.includes(token)) fail('DEMO_TRAFFIC_SECRET_ALIAS_FORBIDDEN');
  const expiresAt = typeof expiry === 'string' ? Date.parse(expiry) : NaN;
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expiry
    || expiresAt > now + MAX_WINDOW_MS) fail('DEMO_TRAFFIC_EXPIRY_INVALID');
  return Object.freeze({ mode, token, expiresAt });
}
