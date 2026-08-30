import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import {
  createPostgresPlatformRuntimeStatusRepository,
} from '../src/persistence/postgres/platform-runtime-status-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = 'b1111111-1111-4111-8111-111111111111';
const TENANT_B = 'b2222222-2222-4222-8222-222222222222';
const TENANT_UNMAPPED = 'b3333333-3333-4333-8333-333333333333';
const DEPLOYMENT_A = 'b4444444-4444-4444-8444-444444444444';
const DEPLOYMENT_B = 'b5555555-5555-4555-8555-555555555555';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function setRuntimeTriggers(pool, enabled) {
  const action = enabled ? 'ENABLE' : 'DISABLE';
  for (const table of [
    'platform_runtime_tenant_mappings',
    'platform_runtime_deployments',
  ]) {
    await pool.query(`ALTER TABLE ${table} ${action} TRIGGER USER`);
  }
}

async function resetFixtures(pool) {
  await setRuntimeTriggers(pool, false);
  try {
    await pool.query(
      'DELETE FROM platform_runtime_tenant_mappings WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B, TENANT_UNMAPPED]],
    );
    await pool.query(
      'DELETE FROM platform_runtime_deployments WHERE id = ANY($1::uuid[])',
      [[DEPLOYMENT_A, DEPLOYMENT_B]],
    );
  } finally {
    await setRuntimeTriggers(pool, true);
  }
  await pool.query('DROP TABLE IF EXISTS platform_runtime_audit_probe');
  await removeSaas2TenantAdministrationFixtures(pool, [TENANT_A, TENANT_B, TENANT_UNMAPPED]);
  await pool.query(
    'DELETE FROM tenants WHERE id = ANY($1::uuid[])',
    [[TENANT_A, TENANT_B, TENANT_UNMAPPED]],
  );
}

async function seedRuntime(pool) {
  await pool.query(
    `INSERT INTO tenants (id, display_name, status)
     VALUES
       ($1, 'Runtime A', 'active'),
       ($2, 'Runtime B', 'active'),
       ($3, 'Runtime Unmapped', 'active')`,
    [TENANT_A, TENANT_B, TENANT_UNMAPPED],
  );
  await pool.query(
    `INSERT INTO platform_runtime_deployments (
       id, environment, deployment_reference, deployed_at,
       frontend_environment, frontend_deployment_reference,
       frontend_expected_version, frontend_expected_build_id,
       frontend_version, frontend_build_id,
       api_environment, api_deployment_reference,
       api_expected_version, api_expected_build_id, api_version, api_build_id,
       schema_environment, schema_deployment_reference,
       schema_expected_version, schema_current_version,
       dependencies_environment, dependencies_deployment_reference,
       required_dependencies_state, optional_dependencies_state, observed_at,
       release_evidence_reference, change_evidence_reference,
       rollback_evidence_reference, runbook_evidence_reference
     )
     VALUES
       (
         $1, 'pilot', 'pilot-a', '2026-08-28T10:00:00.000Z',
         'pilot', 'pilot-a', '3.0.0', 'web-a', '3.0.0', 'web-a',
         'pilot', 'pilot-a', '3.0.0', 'api-a', '3.0.0', 'api-a',
         'pilot', 'pilot-a', 33, 33,
         'pilot', 'pilot-a', 'ready', 'ready', '2026-08-28T10:01:00.000Z',
         'release:pilot-a', 'change:pilot-a', 'rollback:pilot-a', 'runbook:platform'
       ),
       (
         $2, 'production', 'production-b', '2026-08-28T10:00:00.000Z',
         'production', 'production-b', '3.0.0', 'web-b', '3.0.0', 'web-b',
         'production', 'production-b', '3.0.0', 'api-b', '3.0.0', 'api-b',
         'production', 'production-b', 33, 32,
         'production', 'production-b', 'not_ready', 'unknown',
         '2026-08-28T10:01:00.000Z',
         'release:production-b', 'change:production-b',
         'rollback:production-b', 'runbook:platform'
       )`,
    [DEPLOYMENT_A, DEPLOYMENT_B],
  );
  await pool.query(
    `INSERT INTO platform_runtime_tenant_mappings (tenant_id, deployment_id)
     VALUES ($1, $2), ($3, $4)`,
    [TENANT_A, DEPLOYMENT_A, TENANT_B, DEPLOYMENT_B],
  );
}

test('Platform runtime PostgreSQL reads are scoped, minimized and audit-atomic', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  let rejectAudit = false;
  const auditRepository = {
    async appendWithClient(client, event, { expectedTargetTenantId } = {}) {
      await client.query(
        `INSERT INTO platform_runtime_audit_probe (target_tenant_id, payload)
         VALUES ($1, $2::jsonb)`,
        [expectedTargetTenantId ?? null, JSON.stringify(event)],
      );
      if (rejectAudit) throw new Error('RUNTIME_AUDIT_REJECTED');
      return Object.freeze({ recorded: true });
    },
  };

  t.after(async () => {
    try {
      await resetFixtures(pool);
    } finally {
      await pool.end();
    }
  });

  await migrateUp(pool);
  await resetFixtures(pool);
  await pool.query(`
    CREATE TABLE platform_runtime_audit_probe (
      id BIGSERIAL PRIMARY KEY,
      target_tenant_id UUID,
      payload JSONB NOT NULL
    )
  `);
  await seedRuntime(pool);
  const repository = createPostgresPlatformRuntimeStatusRepository(pool, { auditRepository });

  await t.test('fleet and Tenant reads record bounded evidence in the read transaction', async () => {
    const deployments = await repository.listApprovedDeployments({
      auditEventFor: ({ resultCount }) => ({ operation: 'runtime_list', resultCount }),
    });
    assert.deepEqual(
      deployments.map(({ environment, deployment }) => [environment, deployment.reference]),
      [['pilot', 'pilot-a'], ['production', 'production-b']],
    );
    assert.equal('hostname' in deployments[0], false);
    assert.equal('connectionString' in deployments[0], false);

    const tenantA = await repository.findServingDeploymentByTenantId(TENANT_A, {
      auditEventFor: ({ correlationState }) => ({ operation: 'runtime_tenant', correlationState }),
    });
    assert.equal(tenantA.tenantId, TENANT_A);
    assert.equal(tenantA.runtime.deployment.reference, 'pilot-a');

    const unmapped = await repository.findServingDeploymentByTenantId(TENANT_UNMAPPED, {
      auditEventFor: ({ correlationState }) => ({ operation: 'runtime_tenant', correlationState }),
    });
    assert.equal(unmapped, null);
    const evidence = await pool.query(
      `SELECT target_tenant_id, payload
       FROM platform_runtime_audit_probe
       ORDER BY id`,
    );
    assert.equal(evidence.rowCount, 3);
    assert.equal(evidence.rows[0].target_tenant_id, null);
    assert.equal(evidence.rows[0].payload.resultCount, 2);
    assert.equal(evidence.rows[1].target_tenant_id, TENANT_A);
    assert.equal(evidence.rows[2].payload.correlationState, 'unknown');
  });

  await t.test('a Tenant key cannot select another Tenant mapping', async () => {
    const tenantB = await repository.findServingDeploymentByTenantId(TENANT_B, {
      auditEventFor: ({ correlationState }) => ({ operation: 'runtime_tenant', correlationState }),
    });
    assert.equal(tenantB.tenantId, TENANT_B);
    assert.equal(tenantB.runtime.deployment.reference, 'production-b');
    assert.notEqual(tenantB.runtime.deployment.reference, 'pilot-a');
  });

  await t.test('audit failure rolls back evidence and fails the read closed', async () => {
    const before = Number((await pool.query(
      'SELECT COUNT(*) AS count FROM platform_runtime_audit_probe',
    )).rows[0].count);
    rejectAudit = true;
    await assert.rejects(
      repository.findServingDeploymentByTenantId(TENANT_A, {
        auditEventFor: () => ({ operation: 'runtime_tenant' }),
      }),
      { message: 'RUNTIME_AUDIT_REJECTED' },
    );
    rejectAudit = false;
    assert.equal(Number((await pool.query(
      'SELECT COUNT(*) AS count FROM platform_runtime_audit_probe',
    )).rows[0].count), before);
  });

  await t.test('schema constraints and routing triggers reject unsafe source records', async () => {
    await assert.rejects(
      pool.query(
        `UPDATE platform_runtime_deployments
         SET runbook_evidence_reference = 'https://internal.example/runbook',
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [DEPLOYMENT_A],
      ),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform_runtime_deployments
         SET record_state = 'superseded',
             retain_until = clock_timestamp() + INTERVAL '24 months',
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [DEPLOYMENT_A],
      ),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE platform_runtime_tenant_mappings
         SET tenant_id = $2,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1`,
        [TENANT_A, TENANT_UNMAPPED],
      ),
      (error) => error.code === '23514',
    );
  });
});
