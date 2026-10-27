import { createHash, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../src/domain/identifiers.js';
import { withProtectedRuntimeSharedGate } from '../../src/persistence/postgres/protected-runtime-gate.js';
import { loadMigrations } from '../db-migrations.mjs';
import { readCollectedRuntimeObservation } from './protected-runtime-observation-collector.mjs';
import { OBSERVATION_MAX_AGE_MS, refuseRuntimeObservation } from './protected-runtime-observation-plan.mjs';

const MAX_ROUTED_TENANTS = 100;
const MAX_APPROVED_DEPLOYMENTS = 50;

async function assertOwnerAndLedger(client, expectedOfflineRole, migrations) {
  const owner = await client.query(`SELECT current_user AS active_role, session_user AS authenticated_role,
    pg_get_userbyid(relowner) AS owner_role FROM pg_class WHERE oid='public.platform_runtime_deployments'::regclass`);
  if (owner.rowCount !== 1 || ['active_role', 'authenticated_role', 'owner_role']
    .some(key => owner.rows[0][key] !== expectedOfflineRole)) refuseRuntimeObservation();
  const ledger = await client.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version LIMIT $1',
    [migrations.length + 1]);
  if (ledger.rowCount !== migrations.length || ledger.rows.some((row, index) => row.version !== migrations[index].version
    || row.name !== migrations[index].name || row.checksum !== migrations[index].checksum)) refuseRuntimeObservation();
}

async function writeObservation(client, plan, observed, currentSchemaVersion, observedAt) {
  const deployment = plan[observed.surface], reference = `render:${deployment.deploymentReference}`;
  const result = await client.query(`INSERT INTO platform_runtime_deployments (
    id,environment,deployment_reference,deployed_at,
    frontend_environment,frontend_deployment_reference,frontend_expected_version,frontend_expected_build_id,
    frontend_version,frontend_build_id,
    api_environment,api_deployment_reference,api_expected_version,api_expected_build_id,api_version,api_build_id,
    schema_environment,schema_deployment_reference,schema_expected_version,schema_current_version,
    dependencies_environment,dependencies_deployment_reference,required_dependencies_state,optional_dependencies_state,
    observed_at,release_evidence_reference,change_evidence_reference,rollback_evidence_reference,runbook_evidence_reference)
    VALUES($1,'test',$2,$3,'test',$2,$4,$4,$4,$4,'test',$2,$5,$6,$5,$6,'test',$2,$7,$7,
      'test',$2,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(environment,deployment_reference) DO UPDATE SET
      frontend_expected_version=EXCLUDED.frontend_expected_version,frontend_expected_build_id=EXCLUDED.frontend_expected_build_id,
      frontend_version=EXCLUDED.frontend_version,frontend_build_id=EXCLUDED.frontend_build_id,
      api_expected_version=EXCLUDED.api_expected_version,api_expected_build_id=EXCLUDED.api_expected_build_id,
      api_version=EXCLUDED.api_version,api_build_id=EXCLUDED.api_build_id,
      schema_expected_version=EXCLUDED.schema_expected_version,schema_current_version=EXCLUDED.schema_current_version,
      required_dependencies_state=EXCLUDED.required_dependencies_state,optional_dependencies_state=EXCLUDED.optional_dependencies_state,
      observed_at=EXCLUDED.observed_at,release_evidence_reference=EXCLUDED.release_evidence_reference,
      change_evidence_reference=EXCLUDED.change_evidence_reference,rollback_evidence_reference=EXCLUDED.rollback_evidence_reference,
      runbook_evidence_reference=EXCLUDED.runbook_evidence_reference,
      revision=platform_runtime_deployments.revision+1,updated_at=GREATEST(clock_timestamp(),platform_runtime_deployments.updated_at)
    WHERE platform_runtime_deployments.record_state='approved'
      AND platform_runtime_deployments.deployed_at=EXCLUDED.deployed_at
      AND platform_runtime_deployments.frontend_build_id=EXCLUDED.frontend_build_id
      AND platform_runtime_deployments.api_build_id=EXCLUDED.api_build_id
      AND platform_runtime_deployments.observed_at<EXCLUDED.observed_at
    RETURNING id`, [randomUUID(), reference, deployment.deployedAt, observed.frontendBuildId,
    observed.apiVersion, observed.apiBuildId, currentSchemaVersion, observed.required, observed.optional,
    new Date(observedAt).toISOString(), plan.evidence.release, plan.evidence.change, plan.evidence.rollback, plan.evidence.runbook]);
  if (result.rowCount !== 1 || !isInternalUuid(result.rows[0].id)) refuseRuntimeObservation();
  return result.rows[0].id;
}

// Offline deployment-owner process only. Ordinary runtime roles stay read-only
// on observations/mappings. No reset, classification, business or identity write.
export async function reconcileProtectedRuntimeObservation(pool, receipt, { expectedOfflineRole } = {}) {
  try {
    const { plan, surfaces, observedAt } = readCollectedRuntimeObservation(receipt);
    if (typeof expectedOfflineRole !== 'string' || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedOfflineRole)
      || expectedOfflineRole.startsWith('cm_protected_')) refuseRuntimeObservation();
    const migrations = await loadMigrations();
    if (!migrations.length || migrations.some((row, index) => row.version !== index + 1)) refuseRuntimeObservation();
    return await withProtectedRuntimeSharedGate(pool, 'int', async client => {
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(740194,2) AS locked');
      if (lock.rows[0]?.locked !== true) refuseRuntimeObservation();
      await assertOwnerAndLedger(client, expectedOfflineRole, migrations);
      const deployment = await client.query(`SELECT security_epoch FROM protected_runtime_deployments
        WHERE environment='int' AND security_epoch=$1 FOR SHARE`, [plan.securityEpoch]);
      const clock = await client.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
      const now = clock.rows[0]?.now?.getTime();
      if (deployment.rowCount !== 1 || !Number.isSafeInteger(now) || now < observedAt
        || now - observedAt >= OBSERVATION_MAX_AGE_MS) refuseRuntimeObservation();
      const routing = await client.query(`SELECT r.tenant_id FROM tenant_runtime_registry r
        JOIN tenants t ON t.id=r.tenant_id
        LEFT JOIN synthetic_tenant_generations g ON g.environment=r.environment AND g.id=r.generation_id
        LEFT JOIN platform_operators o ON o.id=g.operator_id
        WHERE r.environment='int' AND t.status<>'archived'
          AND (r.mode='real' OR (r.mode='synthetic' AND g.state='active' AND g.security_epoch=$1
            AND o.status='active' AND o.security_version=g.operator_security_version))
        ORDER BY r.tenant_id LIMIT $2`, [plan.securityEpoch, MAX_ROUTED_TENANTS + 1]);
      if (routing.rowCount > MAX_ROUTED_TENANTS || routing.rows.some(row => !isInternalUuid(row.tenant_id))) refuseRuntimeObservation();
      const approved = await client.query(`SELECT environment,deployment_reference FROM platform_runtime_deployments
        WHERE record_state='approved' ORDER BY environment,deployment_reference LIMIT $1`, [MAX_APPROVED_DEPLOYMENTS + 1]);
      const references = new Set(approved.rows.map(row => `${row.environment}\u0000${row.deployment_reference}`));
      const additional = surfaces.filter(row => !references.has(`test\u0000render:${plan[row.surface].deploymentReference}`)).length;
      if (approved.rowCount + additional > MAX_APPROVED_DEPLOYMENTS) refuseRuntimeObservation();
      const ids = {};
      for (const observed of surfaces) {
        ids[observed.surface] = await writeObservation(client, plan, observed, migrations.length, observedAt);
      }
      // The Customer process serves Tenant traffic. Never map a Tenant to the
      // Platform process simply because both roots share the same source pair.
      for (const row of routing.rows) {
        const previous = await client.query(`SELECT d.environment FROM platform_runtime_tenant_mappings m
          JOIN platform_runtime_deployments d ON d.id=m.deployment_id WHERE m.tenant_id=$1 FOR UPDATE OF m`, [row.tenant_id]);
        if (previous.rowCount > 1 || previous.rows.some(value => value.environment !== 'test')) refuseRuntimeObservation();
        await client.query(`INSERT INTO platform_runtime_tenant_mappings(tenant_id,deployment_id) VALUES($1,$2)
          ON CONFLICT(tenant_id) DO UPDATE SET deployment_id=EXCLUDED.deployment_id,
            revision=platform_runtime_tenant_mappings.revision+1,
            updated_at=GREATEST(clock_timestamp(),platform_runtime_tenant_mappings.updated_at)
          WHERE platform_runtime_tenant_mappings.deployment_id<>EXCLUDED.deployment_id`, [row.tenant_id, ids.customer]);
      }
      const sourceDigest = createHash('sha256').update(JSON.stringify({ plan, surfaces, observedAt,
        schema: migrations.length, routing: routing.rows })).digest('hex');
      return Object.freeze({ schemaVersion: 1, operation: 'reconcile_protected_int_runtime_observation',
        observedAt: new Date(observedAt).toISOString(), databaseSchemaVersion: migrations.length,
        deployments: 2, routedTenants: routing.rowCount, sourceDigest });
    });
  } catch { refuseRuntimeObservation(); }
}
