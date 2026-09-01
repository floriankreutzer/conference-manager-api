import {
  DEMO_DATABASE_SENTINEL_KEY,
  DEMO_RUNTIME_SCHEMA_VERSION,
} from '../../demo/runtime-contract.js';
import {
  semanticChecksum,
  validateDemoFixture,
} from '../../demo/fixture.js';
import { withPostgresTransaction } from './transaction.js';
import { acquireDemoRuntimeResetTransactionLock } from './demo-runtime-gate.js';
import {
  readDemoSemanticState,
  seedDemoBusinessState,
} from './demo-fixture-state.js';

const PRODUCTION_SCHEMA_VERSION = 34;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const DATABASE_NAME_PATTERN = /^conference_manager_demo_[a-z0-9_]{1,48}$/;
const DATABASE_ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const PRODUCTION_SCHEMA_VERSIONS = Object.freeze(Array.from(
  { length: PRODUCTION_SCHEMA_VERSION },
  (_, index) => index + 1,
));

export const DEMO_RESET_FAILURE_REASON = Object.freeze({
  GATE: 'gate_failed',
  TRANSACTION: 'transaction_failed',
  TRANSACTION_LOCK: 'transaction_lock_failed',
  PRECONDITIONS: 'preconditions_failed',
  AUTHORITY: 'authority_failed',
  TRUNCATE: 'truncate_failed',
  AUDIT_CHAIN: 'audit_chain_failed',
  BUSINESS_SEED: 'business_seed_failed',
  PROVIDER_SEED: 'provider_seed_failed',
  PERSONA_SEED: 'persona_seed_failed',
  SEMANTIC_READ: 'semantic_read_failed',
  SEMANTIC_CHECKSUM: 'semantic_checksum_failed',
  SUCCESS_AUDIT: 'success_audit_failed',
  UNKNOWN: 'reset_failed',
});
const RESET_FAILURE_REASONS = new Set(Object.values(DEMO_RESET_FAILURE_REASON));

export const DEMO_RESET_TABLES = Object.freeze([
  'tenants',
  'users',
  'sites',
  'rooms',
  'services',
  'catering_packages',
  'catering_items',
  'integrations',
  'requests',
  'notifications',
  'audit_events',
  'sessions',
  'tenant_entitlements',
  'booking_provider_references',
  'oidc_auth_transactions',
  'tenant_onboarding_invitations',
  'tenant_identity_bindings',
  'tenant_claim_transactions',
  'user_identity_bindings',
  'tenant_user_roles',
  'microsoft365_consent_transactions',
  'microsoft365_room_mappings',
  'microsoft365_capability_health',
  'booking_change_requests',
  'tenant_location_revisions',
  'tenant_organization_settings',
  'tenant_organization_revisions',
  'equipment',
  'catering_package_variants',
  'catering_package_items',
  'service_site_applicability',
  'service_room_applicability',
  'equipment_site_applicability',
  'equipment_room_applicability',
  'catering_package_site_applicability',
  'catering_package_room_applicability',
  'catering_item_site_applicability',
  'catering_item_room_applicability',
  'tenant_catalogue_revisions',
  'tenant_booking_policy_configuration',
  'tenant_booking_policy_revisions',
  'tenant_cost_allocation_configuration',
  'tenant_cost_centers',
  'tenant_cost_allocation_revisions',
  'request_v2_migration_state',
  'tenant_room_prices',
  'request_revisions',
  'tenant_bulk_transfer_receipts',
  'platform_operators',
  'platform_operator_tenant_scopes',
  'platform_sessions',
  'platform_oidc_auth_transactions',
  'platform_break_glass_grants',
  'platform_break_glass_alert_outbox',
  'platform_security_alert_outbox',
  'platform_operator_change_alert_outbox',
  'platform_audit_events',
  'platform_audit_checkpoints',
  'platform_audit_chain_state',
  'platform_operation_receipts',
  'platform_entitlement_packages',
  'platform_entitlement_package_revisions',
  'platform_entitlement_change_history',
  'platform_tenant_readiness_snapshots',
  'platform_tenant_readiness_evidence',
  'platform_microsoft_fleet_snapshots',
  'platform_microsoft_fleet_capabilities',
  'microsoft365_room_discovery_observations',
  'platform_diagnostic_events',
  'platform_recovery_contexts',
  'platform_microsoft_reconsent_handoffs',
  'platform_metering_events',
  'platform_metering_periods',
  'platform_metering_period_revisions',
  'platform_operational_quotas',
  'platform_quota_operation_receipts',
  'platform_runtime_deployments',
  'platform_runtime_tenant_mappings',
  'demo_provider_simulations',
  'demo_persona_references',
]);

const EXPECTED_TABLES = Object.freeze([
  ...DEMO_RESET_TABLES,
  'schema_migrations',
  'demo_schema_migrations',
  'demo_database_sentinel',
].sort());
const TRUNCATE_SQL = `TRUNCATE TABLE ${DEMO_RESET_TABLES
  .map((table) => `public.${table}`)
  .join(', ')}`;

export class DemoResetRepositoryError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = 'DemoResetRepositoryError';
    this.code = code;
  }
}

function fail(code, cause) {
  throw new DemoResetRepositoryError(code, cause ? { cause } : undefined);
}

function failureReason(value) {
  return RESET_FAILURE_REASONS.has(value) ? value : DEMO_RESET_FAILURE_REASON.UNKNOWN;
}

function assertFactoryConfiguration({ expectedDatabaseName, expectedResetRole, seedBusinessState, readSemanticState }) {
  if (typeof expectedDatabaseName !== 'string' || !DATABASE_NAME_PATTERN.test(expectedDatabaseName)) {
    throw new TypeError('DEMO_RESET_DATABASE_NAME_INVALID');
  }
  if (typeof expectedResetRole !== 'string' || !DATABASE_ROLE_PATTERN.test(expectedResetRole)) {
    throw new TypeError('DEMO_RESET_DATABASE_ROLE_INVALID');
  }
  if (typeof seedBusinessState !== 'function') throw new TypeError('DEMO_RESET_SEEDER_REQUIRED');
  if (typeof readSemanticState !== 'function') throw new TypeError('DEMO_RESET_SEMANTIC_READER_REQUIRED');
}

function assertSentinel(row, expectedDatabaseName, expectedResetRole) {
  if (
    !row
    || row.sentinel_key !== DEMO_DATABASE_SENTINEL_KEY
    || Number(row.runtime_schema_version) !== DEMO_RUNTIME_SCHEMA_VERSION
    || row.database_name !== expectedDatabaseName
    || row.current_database !== expectedDatabaseName
    || row.reset_role !== expectedResetRole
    || row.current_role !== expectedResetRole
    || !Array.isArray(row.production_schema_versions)
    || row.production_schema_versions.length !== PRODUCTION_SCHEMA_VERSIONS.length
    || row.production_schema_versions.some(
      (version, index) => Number(version) !== PRODUCTION_SCHEMA_VERSIONS[index],
    )
    || typeof row.customer_role !== 'string'
    || typeof row.platform_role !== 'string'
    || row.customer_role === row.platform_role
    || row.customer_role === row.reset_role
    || row.platform_role === row.reset_role
  ) fail('DEMO_RESET_SENTINEL_INVALID');
}

function assertTableInventory(rows) {
  if (!Array.isArray(rows)) fail('DEMO_RESET_SCHEMA_INVENTORY_INVALID');
  const actual = rows.map(({ tablename }) => tablename).sort();
  if (
    actual.length !== EXPECTED_TABLES.length
    || actual.some((table, index) => table !== EXPECTED_TABLES[index])
  ) fail('DEMO_RESET_SCHEMA_INVENTORY_INVALID');
}

async function verifyPreconditions(client, expectedDatabaseName, expectedResetRole) {
  const sentinel = await client.query({
    name: 'demo-reset-sentinel',
    text: `
      SELECT
        sentinel_key,
        runtime_schema_version,
        database_name::text,
        customer_role::text,
        platform_role::text,
        reset_role::text,
        current_database() AS current_database,
        current_user::text AS current_role,
        (
          SELECT COALESCE(array_agg(version ORDER BY version), ARRAY[]::integer[])
          FROM schema_migrations
        ) AS production_schema_versions
      FROM demo_database_sentinel
      WHERE singleton = true
    `,
  });
  if (sentinel.rowCount !== 1) fail('DEMO_RESET_SENTINEL_INVALID');
  assertSentinel(sentinel.rows[0], expectedDatabaseName, expectedResetRole);
  const inventory = await client.query({
    name: 'demo-reset-schema-inventory',
    text: `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `,
  });
  assertTableInventory(inventory.rows);
}

async function verifyResetAuthority(client, authority) {
  const result = await client.query({
    name: 'demo-reset-authority-revalidation',
    text: `
      SELECT 1
      FROM platform_sessions AS platform_session
      JOIN platform_operators AS operator
        ON operator.id = platform_session.operator_id
      WHERE platform_session.id = $1
        AND platform_session.operator_id = $2
        AND platform_session.principal_version = $3
        AND platform_session.revoked_at IS NULL
        AND platform_session.expires_at > clock_timestamp()
        AND platform_session.step_up_expires_at > clock_timestamp()
        AND platform_session.assurance_level = 'step_up'
        AND operator.status = 'active'
        AND operator.security_version = $3
      FOR UPDATE OF platform_session, operator
    `,
    values: [authority.sessionId, authority.operatorId, authority.securityVersion],
  });
  if (result.rowCount !== 1) fail('DEMO_RESET_AUTHORITY_REVOKED');
}

async function insertProviderState(client, fixture) {
  for (const tenant of fixture.tenants) {
    const state = tenant.providerSimulation;
    await client.query({
      name: 'demo-reset-insert-provider-simulation',
      text: `
        INSERT INTO demo_provider_simulations (
          tenant_id, provider, connection_state, health, scenario
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      values: [tenant.id, state.provider, state.connectionState, state.health, state.scenario],
    });
  }
}

async function insertPersonaReferences(client, fixture) {
  const personas = [
    ...fixture.customerPersonas.map((persona) => ({
      surface: 'customer',
      contextKey: `${persona.tenantId}:${persona.persona}`,
      tenantId: persona.tenantId,
      persona: persona.persona,
      subjectId: persona.userId,
      providerIdentity: {
        provider: persona.providerIdentity.provider,
        tenantReference: null,
        subjectReference: persona.providerIdentity.reference,
      },
      assurance: null,
    })),
    ...fixture.platform.personas.map((persona) => ({
      surface: 'platform',
      contextKey: persona.persona,
      tenantId: null,
      persona: persona.persona,
      subjectId: persona.operatorId,
      providerIdentity: persona.providerIdentity,
      assurance: persona.assurance,
    })),
  ];
  for (const persona of personas) {
    await client.query({
      name: 'demo-reset-insert-persona-reference',
      text: `
        INSERT INTO demo_persona_references (
          surface, context_key, tenant_id, persona, subject_id,
          provider, provider_tenant_reference, provider_subject_reference,
          assurance_level, authentication_context
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      values: [
        persona.surface,
        persona.contextKey,
        persona.tenantId,
        persona.persona,
        persona.subjectId,
        persona.providerIdentity.provider,
        persona.providerIdentity.tenantReference,
        persona.providerIdentity.subjectReference,
        persona.assurance?.level || null,
        persona.assurance?.authenticationContext || null,
      ],
    });
  }
}

export function createPostgresDemoResetRepository({
  pool,
  expectedDatabaseName,
  expectedResetRole,
  auditRepository = null,
  seedBusinessState = seedDemoBusinessState,
  readSemanticState = readDemoSemanticState,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (
    auditRepository !== null
    && (
      typeof auditRepository.append !== 'function'
      || typeof auditRepository.appendWithClient !== 'function'
    )
  ) throw new TypeError('DEMO_RESET_AUDIT_REPOSITORY_INVALID');
  assertFactoryConfiguration({ expectedDatabaseName, expectedResetRole, seedBusinessState, readSemanticState });

  return Object.freeze({
    async reset({ fixture, checksum, authority = null, auditEventFor = null } = {}) {
      validateDemoFixture(fixture);
      if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
        throw new TypeError('DEMO_RESET_CHECKSUM_INVALID');
      }
      if (semanticChecksum(fixture) !== checksum) fail('DEMO_RESET_CHECKSUM_MISMATCH');
      if (auditEventFor !== null && typeof auditEventFor !== 'function') {
        throw new TypeError('DEMO_RESET_AUDIT_EVENT_FACTORY_INVALID');
      }
      if (auditEventFor !== null && auditRepository === null) {
        throw new TypeError('DEMO_RESET_AUDIT_REPOSITORY_REQUIRED');
      }
      if ((auditEventFor === null) !== (authority === null)) {
        throw new TypeError('DEMO_RESET_AUTHORITY_REQUIRED');
      }
      let phase = DEMO_RESET_FAILURE_REASON.TRANSACTION;
      try {
        return await withPostgresTransaction(pool, async (client) => {
          phase = DEMO_RESET_FAILURE_REASON.TRANSACTION_LOCK;
          await acquireDemoRuntimeResetTransactionLock(client);
          phase = DEMO_RESET_FAILURE_REASON.PRECONDITIONS;
          await verifyPreconditions(client, expectedDatabaseName, expectedResetRole);
          if (authority !== null) {
            phase = DEMO_RESET_FAILURE_REASON.AUTHORITY;
            await verifyResetAuthority(client, authority);
          }
          phase = DEMO_RESET_FAILURE_REASON.TRUNCATE;
          await client.query({ name: 'demo-reset-truncate', text: TRUNCATE_SQL });
          phase = DEMO_RESET_FAILURE_REASON.AUDIT_CHAIN;
          await client.query({
            name: 'demo-reset-audit-chain-state',
            text: 'INSERT INTO platform_audit_chain_state (singleton) VALUES (true)',
          });
          phase = DEMO_RESET_FAILURE_REASON.BUSINESS_SEED;
          await seedBusinessState({ client, fixture });
          phase = DEMO_RESET_FAILURE_REASON.PROVIDER_SEED;
          await insertProviderState(client, fixture);
          phase = DEMO_RESET_FAILURE_REASON.PERSONA_SEED;
          await insertPersonaReferences(client, fixture);
          phase = DEMO_RESET_FAILURE_REASON.SEMANTIC_READ;
          const semanticState = await readSemanticState({ client });
          phase = DEMO_RESET_FAILURE_REASON.SEMANTIC_CHECKSUM;
          if (semanticChecksum(semanticState) !== checksum) fail('DEMO_RESET_SEMANTIC_CHECKSUM_MISMATCH');
          if (auditEventFor !== null) {
            phase = DEMO_RESET_FAILURE_REASON.SUCCESS_AUDIT;
            await auditRepository.appendWithClient(client, auditEventFor({
              outcome: 'success',
              reasonCode: null,
            }));
          }
          phase = DEMO_RESET_FAILURE_REASON.TRANSACTION;
          return Object.freeze({
            seedVersion: fixture.seedVersion,
            checksum,
          });
        }, { isolationLevel: 'SERIALIZABLE' });
      } catch (error) {
        if (auditEventFor !== null) {
          try {
            await auditRepository.append(auditEventFor({
              outcome: 'failure',
              reasonCode: failureReason(phase),
            }));
          } catch (auditError) {
            throw new DemoResetRepositoryError('DEMO_RESET_FAILURE_AUDIT_FAILED', {
              cause: auditError,
            });
          }
        }
        throw error;
      }
    },
  });
}
