import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const NEON_RECOVERY_PREFLIGHT_FAILURE_FILE = 'neon-recovery-preflight-failure.json';
const STAGES = Object.freeze(['configuration', 'identities', 'schema', 'database-media',
  'provider-bytes', 'semantic-state', 'commit', 'report']);
const SAFE_CODES = new Set([
  'NEON_RECOVERY_MODE_INVALID', 'NEON_RECOVERY_CONTEXT_INVALID', 'NEON_RECOVERY_DATABASE_INVALID',
  'NEON_RECOVERY_IDENTITY_INVALID', 'NEON_RECOVERY_MARKER_INVALID', 'NEON_RECOVERY_SCHEMA_INVALID',
  'NEON_RECOVERY_MEDIA_INVALID', 'NEON_RECOVERY_MANIFEST_INVALID', 'NEON_RECOVERY_DIAGNOSTIC_STAGE_INVALID',
  'MEDIA_STORAGE_CONFIG_INVALID', 'MEDIA_OBJECT_REFERENCE_INVALID', 'MEDIA_STORAGE_OBJECT_MISSING',
  'MEDIA_STORAGE_INTEGRITY_FAILED', 'MEDIA_STORAGE_UNAVAILABLE', 'MEDIA_STORAGE_BACKFILL_REQUIRED',
  'DEMO_SEMANTIC_TIME_INVALID', 'DEMO_SEMANTIC_INTEGER_INVALID', 'DEMO_FIXTURE_CHECKSUM_INVALID',
  'DEMO_FIXTURE_CHECKSUM_MISMATCH', 'DEMO_FIXTURE_MEDIA_BYTES_DIVERGED', 'DEMO_FIXTURE_CATALOGUE_MEDIA_BYTES_DIVERGED',
  'DEMO_FIXTURE_MEDIA_REFERENCES_DIVERGED', 'DEMO_FIXTURE_CATALOGUE_MEDIA_REFERENCES_DIVERGED',
  'DEMO_FIXTURE_REQUEST_REVISION_DIVERGED',
]);

function safeCode(error) {
  // Read only own data properties: neither getters nor provider serialization
  // may run while extracting an exact, locally owned diagnostic constant.
  try {
    for (const key of ['code', 'message']) {
      const value = Object.getOwnPropertyDescriptor(error, key)?.value;
      if (SAFE_CODES.has(value)) return value;
    }
  } catch { /* Unknown thrown values retain no external details. */ }
  return 'UNKNOWN';
}

// Diagnostic progress is observational. It never changes exercise expiry,
// database/provider deadlines, the existing checks or their failure semantics.
export function createNeonRecoveryPreflightDiagnostics({ sourceRuntimeRef, now = () => performance.now() } = {}) {
  const source = typeof sourceRuntimeRef === 'string' && /^[a-f0-9]{40}$/.test(sourceRuntimeRef) ? sourceRuntimeRef : null;
  const startedAt = now();
  let index = 0;
  let stageStartedAt = startedAt;

  function failure(error) {
    const observedAt = now();
    return Object.freeze({ schemaVersion: 1, scope: 'restored-pair-preflight-failure-not-acceptance', outcome: 'failed',
      sourceRuntimeRef: source, stage: STAGES[index], code: safeCode(error),
      completedStages: Object.freeze(STAGES.slice(0, index)),
      elapsedMs: Math.max(0, Math.floor(observedAt - startedAt)),
      stageElapsedMs: Math.max(0, Math.floor(observedAt - stageStartedAt)) });
  }

  return Object.freeze({
    advance(stage) {
      if (index + 1 >= STAGES.length || stage !== STAGES[index + 1]) {
        throw new Error('NEON_RECOVERY_DIAGNOSTIC_STAGE_INVALID');
      }
      stageStartedAt = now();
      index += 1;
    },
    failure,
    async retainFailure(error) {
      // Successful diagnostic retention must never turn a failed preflight green.
      process.exitCode = 1;
      try {
        await writeFile(NEON_RECOVERY_PREFLIGHT_FAILURE_FILE, `${JSON.stringify(failure(error))}\n`, { mode: 0o600, flag: 'wx' });
        return true;
      } catch {
        process.stderr.write('NEON_RECOVERY_DIAGNOSTIC_WRITE_FAILED\n');
        return false;
      }
    },
  });
}
