import { loadDatabaseConfig } from '../../src/config.js';
import { createPostgresPool } from '../../src/persistence/postgres/pool.js';
import { collectProtectedRuntimeObservation } from './protected-runtime-observation-collector.mjs';
import { reconcileProtectedRuntimeObservation } from './protected-runtime-observation-reconciler.mjs';
import { refuseRuntimeObservation } from './protected-runtime-observation-plan.mjs';

export function protectedRuntimeObservationDatabase(env) {
  const expectedOfflineRole = env.PLATFORM_PASSKEY_OFFLINE_ROLE;
  let url, runtime;
  try {
    url = new URL(env.PLATFORM_PASSKEY_OFFLINE_DATABASE_URL);
    runtime = new URL(env.PLATFORM_DATABASE_URL);
  } catch { refuseRuntimeObservation(); }
  if (typeof expectedOfflineRole !== 'string' || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedOfflineRole)
    || expectedOfflineRole.startsWith('cm_protected_') || !['postgres:', 'postgresql:'].includes(url.protocol)
    || url.protocol !== runtime.protocol || url.host !== runtime.host || url.pathname !== runtime.pathname
    || decodeURIComponent(url.username) !== expectedOfflineRole
    || decodeURIComponent(runtime.username) === expectedOfflineRole) refuseRuntimeObservation();
  return Object.freeze({ expectedOfflineRole, databaseUrl: url.href });
}

// Both owned CLIs use the same credential binding and unchanged collector/writer.
// No application entrypoint, arbitrary database selector, signing key or retry port.
export async function executeProtectedRuntimeObservation(selection, env, artifactRoot) {
  const database = protectedRuntimeObservationDatabase(env);
  const receipt = await collectProtectedRuntimeObservation({
    plan: { ...selection, securityEpoch: env.PROTECTED_OBSERVATION_SECURITY_EPOCH }, artifactRoot,
  });
  const pool = createPostgresPool({ mode: 'production', ...loadDatabaseConfig({
    DATABASE_URL: database.databaseUrl, DATABASE_SSL: 'verify-full', DATABASE_POOL_MAX: '1',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000', DATABASE_STATEMENT_TIMEOUT_MS: '10000',
  }, 'production') });
  try { return await reconcileProtectedRuntimeObservation(pool, receipt, { expectedOfflineRole: database.expectedOfflineRole }); }
  finally { await pool.end(); }
}
