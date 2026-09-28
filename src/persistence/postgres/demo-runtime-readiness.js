import { DEMO_FIXTURE } from '../../demo/fixture.js';
import {
  DEMO_OVERLAY_MIGRATION_VERSION,
  DEMO_RUNTIME_SCHEMA_VERSION,
} from '../../demo/runtime-contract.js';

const SURFACES = new Set(['customer', 'platform']);

function sameValues(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function expectedPersonaKeys(surface) {
  return (surface === 'customer'
    ? DEMO_FIXTURE.customerPersonas.map(({ tenantId, persona }) => `${tenantId}:${persona}`)
    : DEMO_FIXTURE.platform.personas.map(({ persona }) => persona)
  ).sort();
}

const EXPECTED_OVERLAY_VERSIONS = Object.freeze(Array.from(
  { length: DEMO_OVERLAY_MIGRATION_VERSION },
  (_, index) => index + 1,
));
const EXPECTED_PROVIDER_TENANTS = Object.freeze(DEMO_FIXTURE.tenants.map(({ id }) => id).sort());

function readinessQuery(surface) {
  const personaView = surface === 'customer'
    ? 'demo_customer_persona_references'
    : 'demo_platform_persona_references';
  const providerSelection = surface === 'platform'
    ? `, (SELECT COALESCE(array_agg(tenant_id::text ORDER BY tenant_id), ARRAY[]::text[])
          FROM demo_provider_simulations) AS provider_tenant_ids`
    : '';
  const authoritySelection = surface === 'customer'
    ? `(SELECT count(*)::integer
          FROM demo_customer_persona_references AS reference
          JOIN tenants AS tenant
            ON tenant.id = reference.tenant_id
           AND (tenant.status IN ('ready', 'active')
             OR (tenant.status = 'onboarding' AND reference.persona = 'tenant_admin'))
          JOIN users AS app_user
            ON app_user.tenant_id = reference.tenant_id
           AND app_user.id = reference.subject_id
           AND app_user.active = true) AS authority_count`
    : `(SELECT count(*)::integer
          FROM demo_platform_persona_references AS reference
          JOIN platform_operators AS operator
            ON operator.id = reference.operator_id AND operator.status = 'active') AS authority_count`;
  return `
    SELECT current_database() AS connected_database,
           current_user AS connected_role,
           sentinel.sentinel_key,
           sentinel.runtime_schema_version,
           sentinel.database_name,
           sentinel.${surface}_role AS recorded_role,
           (SELECT COALESCE(array_agg(version ORDER BY version), ARRAY[]::integer[])
              FROM demo_schema_migrations) AS overlay_versions,
           (SELECT COALESCE(array_agg(context_key ORDER BY context_key), ARRAY[]::text[])
              FROM ${personaView}) AS persona_keys,
           ${authoritySelection}
           ${providerSelection}
    FROM demo_database_sentinel AS sentinel
    WHERE sentinel.singleton = true
  `;
}

export function createPostgresDemoRuntimeReadiness({
  pool,
  surface,
  expectedDatabaseName,
  expectedRole,
  expectedSentinelKey,
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!SURFACES.has(surface)) throw new TypeError('DEMO_READINESS_SURFACE_INVALID');
  if (typeof expectedDatabaseName !== 'string' || expectedDatabaseName.length === 0) {
    throw new TypeError('DEMO_READINESS_DATABASE_INVALID');
  }
  if (typeof expectedRole !== 'string' || expectedRole.length === 0) {
    throw new TypeError('DEMO_READINESS_ROLE_INVALID');
  }
  if (typeof expectedSentinelKey !== 'string' || expectedSentinelKey.length === 0) {
    throw new TypeError('DEMO_READINESS_SENTINEL_INVALID');
  }
  const personas = expectedPersonaKeys(surface);

  async function evaluate() {
    const result = await pool.query({
      name: `demo-${surface}-runtime-readiness`,
      text: readinessQuery(surface),
    });
    if (result.rowCount !== 1) return false;
    const row = result.rows[0];
    const overlayVersions = row.overlay_versions?.map(Number);
    const providerReady = surface !== 'platform'
      || sameValues(row.provider_tenant_ids, EXPECTED_PROVIDER_TENANTS);
    return row.connected_database === expectedDatabaseName
      && row.database_name === expectedDatabaseName
      && row.connected_role === expectedRole
      && row.recorded_role === expectedRole
      && row.sentinel_key === expectedSentinelKey
      && Number(row.runtime_schema_version) === DEMO_RUNTIME_SCHEMA_VERSION
      && sameValues(overlayVersions, EXPECTED_OVERLAY_VERSIONS)
      && sameValues(row.persona_keys, personas)
      && Number(row.authority_count) === personas.length
      && providerReady;
  }

  return Object.freeze({
    async isReady() {
      try {
        return await evaluate();
      } catch {
        return false;
      }
    },
    async assertReady() {
      try {
        if (await evaluate()) return true;
      } catch {
        // Startup exposes only a bounded readiness outcome, never driver connection details.
      }
      throw new Error('DEMO_RUNTIME_NOT_READY');
    },
  });
}
