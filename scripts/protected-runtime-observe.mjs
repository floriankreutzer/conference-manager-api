import path from 'node:path';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { readFixedDescriptorJson } from './lib/fixed-descriptor-json.mjs';
import { requireOwnerMainActionsContext } from './support/owner-main-actions-context.mjs';
import { normalizeRuntimeObservationSelection, refuseRuntimeObservation }
  from './support/protected-runtime-observation-plan.mjs';
import { collectProtectedRuntimeObservation } from './support/protected-runtime-observation-collector.mjs';
import { reconcileProtectedRuntimeObservation } from './support/protected-runtime-observation-reconciler.mjs';

let pool;
try {
  if (process.argv.length !== 2) refuseRuntimeObservation();
  requireOwnerMainActionsContext(process.env, 'protected-int-runtime-observation.yml');
  const selection = normalizeRuntimeObservationSelection(readFixedDescriptorJson(3));
  if (selection.apiCommit !== process.env.GITHUB_SHA) refuseRuntimeObservation();
  const expectedOfflineRole = process.env.PLATFORM_PASSKEY_OFFLINE_ROLE;
  const url = new URL(process.env.PLATFORM_PASSKEY_OFFLINE_DATABASE_URL);
  const runtime = new URL(process.env.PLATFORM_DATABASE_URL);
  if (typeof expectedOfflineRole !== 'string' || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedOfflineRole)
    || expectedOfflineRole.startsWith('cm_protected_') || !['postgres:', 'postgresql:'].includes(url.protocol)
    || url.protocol !== runtime.protocol || url.host !== runtime.host || url.pathname !== runtime.pathname
    || decodeURIComponent(url.username) !== expectedOfflineRole
    || decodeURIComponent(runtime.username) === expectedOfflineRole) refuseRuntimeObservation();
  const receipt = await collectProtectedRuntimeObservation({
    plan: { ...selection, securityEpoch: process.env.PROTECTED_OBSERVATION_SECURITY_EPOCH },
    artifactRoot: path.resolve('.runtime-observation-frontend'),
  });
  pool = createPostgresPool({ mode: 'production', ...loadDatabaseConfig({ DATABASE_URL: url.href,
    DATABASE_SSL: 'verify-full', DATABASE_POOL_MAX: '1', DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_STATEMENT_TIMEOUT_MS: '10000' }, 'production') });
  const result = await reconcileProtectedRuntimeObservation(pool, receipt, { expectedOfflineRole });
  // Minimized deployment-process receipt, not a forged Platform operator audit.
  // No signing key, identity, routing IDs, epoch or connection detail is output.
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('PROTECTED_RUNTIME_OBSERVATION_REFUSED\n');process.exitCode = 1;
} finally {
  try { await pool?.end(); } catch { process.exitCode = 1; }
}
