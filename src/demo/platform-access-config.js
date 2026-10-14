const MODE_KEY = 'DEMO_PLATFORM_ACCESS_MODE';
const HASH_KEY = 'DEMO_PLATFORM_ACCESS_PASSWORD_SHA256';
const KNOWN_KEYS = new Set([MODE_KEY, HASH_KEY]);

export function loadDemoPlatformAccessConfig(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('DEMO_PLATFORM_ACCESS_CONFIG_INVALID');
  }
  const mode = env[MODE_KEY] ?? 'public';
  const passwordHash = env[HASH_KEY] ?? null;
  if (!['public', 'password'].includes(mode)
    || Object.keys(env).some((key) => key.startsWith('DEMO_PLATFORM_ACCESS_') && !KNOWN_KEYS.has(key))
    || (mode === 'password' && (typeof passwordHash !== 'string' || !/^[a-f0-9]{64}$/.test(passwordHash)))
    || (mode === 'public' && passwordHash !== null)) {
    throw new TypeError('DEMO_PLATFORM_ACCESS_CONFIG_INVALID');
  }
  return Object.freeze({ mode, passwordHash });
}
