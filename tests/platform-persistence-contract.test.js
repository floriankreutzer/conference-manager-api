import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Platform persistence uses calendar-correct retention and append-only readiness evidence', async () => {
  const [core, projections, metering] = await Promise.all([
    source('migrations/031_platform_operations_core.up.sql'),
    source('migrations/032_platform_operations_projections.up.sql'),
    source('migrations/033_platform_metering_runtime.up.sql'),
  ]);
  assert.match(core, /CREATE FUNCTION platform_add_utc_months/);
  assert.match(projections, /PRIMARY KEY \(tenant_id, kind, revision\)/);
  assert.match(projections, /PLATFORM_READINESS_EVIDENCE_IMMUTABLE/);
  assert.match(metering, /platform_add_utc_months\(clock_timestamp\(\), 24\)/);
  assert.doesNotMatch(`${core}\n${projections}\n${metering}`, /INTERVAL '24 months/);
});

test('diagnostics query only the minimized immutable projection populated by both audit domains', async () => {
  const [migration, repository] = await Promise.all([
    source('migrations/032_platform_operations_projections.up.sql'),
    source('src/persistence/postgres/platform-operations-read-model-repository.js'),
  ]);
  assert.match(migration, /audit_events_diagnostic_projection/);
  assert.match(migration, /platform_audit_events_diagnostic_projection/);
  const query = repository.slice(repository.indexOf("name: 'platform-diagnostic-correlation-query'"));
  assert.match(query, /FROM platform_diagnostic_events/);
  assert.doesNotMatch(query.slice(0, query.indexOf('values:')), /FROM audit_events|FROM platform_audit_events/);
});

test('Recovery persistence rechecks live Platform session authority before consuming one-use context', async () => {
  const [operations, recovery] = await Promise.all([
    source('src/persistence/postgres/platform-operations-repository.js'),
    source('src/persistence/postgres/platform-operations-recovery-repository.js'),
  ]);
  assert.match(operations, /session\.revoked_at IS NULL/);
  assert.match(operations, /session\.step_up_expires_at > clock_timestamp\(\)/);
  assert.match(recovery, /requireCurrentPlatformMutationAuthorization/);
  assert.match(recovery, /platform-recovery-context-consume/);
  assert.match(recovery, /used_at = \$2/);
  assert.match(recovery, /microsoft365_room_discovery_observations/);
});

test('Recovery lifecycle persistence delegates to the canonical Tenant lifecycle repository', async () => {
  const [recovery, platformPersistence] = await Promise.all([
    source('src/persistence/postgres/platform-operations-recovery-repository.js'),
    source('src/persistence/postgres/platform-index.js'),
  ]);
  assert.match(recovery, /TENANT_LIFECYCLE_REPOSITORY_REQUIRED/);
  assert.match(
    recovery,
    /executeTenantLifecycle[\s\S]*tenantLifecycleRepository\.changeStatusWithClient/,
  );
  assert.doesNotMatch(recovery, /platform-recovery-change-tenant-lifecycle/);
  assert.match(
    platformPersistence,
    /createPostgresPlatformRecoveryRepository[\s\S]*tenantLifecycleRepository: tenantRepository/,
  );
});
