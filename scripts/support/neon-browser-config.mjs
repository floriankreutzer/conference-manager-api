import { loadNeonAcceptanceConfig } from './neon-acceptance-probe.mjs';

// Real storage is fixed to the isolated branch; all database authority stays on
// the runner's disposable database. Validate before allocating any SDK client.
export function assertNeonBrowserDatabase(env) {
  const keys = ['DEMO_CUSTOMER_DATABASE_URL', 'DEMO_PLATFORM_DATABASE_URL',
    'DEMO_RESET_DATABASE_URL', 'DEMO_MIGRATION_DATABASE_URL'];
  let found = false;
  for (const key of keys) {
    if (env[key] === undefined) continue;
    let url;
    try { url = new URL(env[key]); } catch { throw new Error('NEON_BROWSER_DATABASE_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || url.port !== '5432' || url.pathname !== '/conference_manager_demo_ci' || url.search || url.hash) {
      throw new Error('NEON_BROWSER_DATABASE_INVALID');
    }
    found = true;
  }
  if (!found || env.DEMO_DATABASE_SSL !== 'disable') throw new Error('NEON_BROWSER_DATABASE_INVALID');
}

export function loadNeonBrowserStorageConfig(env) {
  const storage = loadNeonAcceptanceConfig(env);
  assertNeonBrowserDatabase(env);
  return storage;
}
