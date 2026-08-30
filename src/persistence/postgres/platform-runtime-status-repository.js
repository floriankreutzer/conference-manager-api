import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const RUNTIME_COLUMN_NAMES = Object.freeze([
  'environment',
  'deployment_reference',
  'deployed_at',
  'frontend_environment',
  'frontend_deployment_reference',
  'frontend_expected_version',
  'frontend_expected_build_id',
  'frontend_version',
  'frontend_build_id',
  'api_environment',
  'api_deployment_reference',
  'api_expected_version',
  'api_expected_build_id',
  'api_version',
  'api_build_id',
  'schema_environment',
  'schema_deployment_reference',
  'schema_expected_version',
  'schema_current_version',
  'dependencies_environment',
  'dependencies_deployment_reference',
  'required_dependencies_state',
  'optional_dependencies_state',
  'observed_at',
  'release_evidence_reference',
  'change_evidence_reference',
  'rollback_evidence_reference',
  'runbook_evidence_reference',
]);
const RUNTIME_COLUMNS = RUNTIME_COLUMN_NAMES.join(',\n            ');
const QUALIFIED_RUNTIME_COLUMNS = RUNTIME_COLUMN_NAMES
  .map((column) => `deployment.${column}`)
  .join(',\n            ');

function instant(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function integer(value) {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new TypeError('PLATFORM_RUNTIME_SCHEMA_INVALID');
  return result;
}

function mapRuntime(row) {
  if (!row) return null;
  return Object.freeze({
    environment: row.environment,
    deployment: Object.freeze({
      reference: row.deployment_reference,
      deployedAt: instant(row.deployed_at),
    }),
    frontend: Object.freeze({
      environment: row.frontend_environment,
      deploymentReference: row.frontend_deployment_reference,
      expectedVersion: row.frontend_expected_version,
      expectedBuildId: row.frontend_expected_build_id,
      version: row.frontend_version,
      buildId: row.frontend_build_id,
    }),
    api: Object.freeze({
      environment: row.api_environment,
      deploymentReference: row.api_deployment_reference,
      expectedVersion: row.api_expected_version,
      expectedBuildId: row.api_expected_build_id,
      version: row.api_version,
      buildId: row.api_build_id,
    }),
    schema: Object.freeze({
      environment: row.schema_environment,
      deploymentReference: row.schema_deployment_reference,
      expectedVersion: integer(row.schema_expected_version),
      currentVersion: integer(row.schema_current_version),
    }),
    dependencies: Object.freeze({
      environment: row.dependencies_environment,
      deploymentReference: row.dependencies_deployment_reference,
      required: row.required_dependencies_state,
      optional: row.optional_dependencies_state,
    }),
    observedAt: instant(row.observed_at),
    evidence: Object.freeze({
      release: row.release_evidence_reference,
      change: row.change_evidence_reference,
      rollback: row.rollback_evidence_reference,
      runbook: row.runbook_evidence_reference,
    }),
  });
}

export function createPostgresPlatformRuntimeStatusRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async listApprovedDeployments({ auditEventFor } = {}) {
      if (typeof auditEventFor !== 'function') {
        throw new TypeError('PLATFORM_RUNTIME_AUDIT_EVENT_FACTORY_REQUIRED');
      }
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'platform-runtime-approved-deployments-list',
          text: `
            SELECT ${RUNTIME_COLUMNS}
            FROM platform_runtime_deployments
            WHERE record_state = 'approved'
            ORDER BY environment, deployed_at DESC, deployment_reference
            LIMIT 51
          `,
        });
        const records = Object.freeze(result.rows.map(mapRuntime));
        const audit = await auditRepository.appendWithClient(
          client,
          auditEventFor({ resultCount: records.length }),
        );
        if (!audit) throw new Error('PLATFORM_RUNTIME_AUDIT_APPEND_FAILED');
        return records;
      }, { isolationLevel: 'REPEATABLE READ' });
    },

    async findServingDeploymentByTenantId(tenantId, { auditEventFor } = {}) {
      if (!isInternalUuid(tenantId)) {
        throw new TypeError('PLATFORM_RUNTIME_TENANT_ID_INVALID');
      }
      if (typeof auditEventFor !== 'function') {
        throw new TypeError('PLATFORM_RUNTIME_AUDIT_EVENT_FACTORY_REQUIRED');
      }
      return withPostgresTransaction(pool, async (client) => {
        const result = await client.query({
          name: 'platform-runtime-tenant-deployment-find',
          text: `
            SELECT ${QUALIFIED_RUNTIME_COLUMNS}
            FROM platform_runtime_tenant_mappings mapping
            JOIN platform_runtime_deployments deployment
              ON deployment.id = mapping.deployment_id
             AND deployment.record_state = 'approved'
            WHERE mapping.tenant_id = $1
            LIMIT 1
          `,
          values: [tenantId],
        });
        const mapped = result.rowCount === 1;
        const audit = await auditRepository.appendWithClient(
          client,
          auditEventFor({ correlationState: mapped ? 'mapped' : 'unknown' }),
          { expectedTargetTenantId: tenantId },
        );
        if (!audit) throw new Error('PLATFORM_RUNTIME_AUDIT_APPEND_FAILED');
        return mapped
          ? Object.freeze({ tenantId, runtime: mapRuntime(result.rows[0]) })
          : null;
      }, { isolationLevel: 'REPEATABLE READ' });
    },
  });
}
