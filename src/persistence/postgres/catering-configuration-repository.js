import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';
import { withPostgresTransaction } from './transaction.js';

const MODES = ['catalogue', 'availability', 'order', 'update', 'cancel', 'status'];

function counter(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_CONFIGURATION_VERSION_INVALID');
  }
  return value;
}

function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CATERING_CONFIGURATION_IDENTIFIER_INVALID');
  return value.toLowerCase();
}

function record(row, registry) {
  if (!row) return null;
  const normalized = normalizeCateringConfiguration({
    initialOrderMode: row.initial_order_mode,
    capabilities: Object.fromEntries(MODES.map((mode) => [`catering.${mode}`, row[`${mode}_mode`]])),
  }, registry.get(row.provider));
  return Object.freeze({
    tenantId: row.tenant_id, integrationId: row.integration_id, providerId: normalized.providerId,
    revision: counter(Number(row.revision)),
    configuration: Object.freeze({ initialOrderMode: normalized.initialOrderMode, capabilities: normalized.capabilities }),
  });
}

async function load(client, tenantId, integrationId, registry) {
  const result = await client.query({
    name: 'catering-configuration-read',
    text: `SELECT configuration.*, integration.provider
      FROM catering_integration_configurations configuration
      JOIN integrations integration ON integration.tenant_id = configuration.tenant_id
        AND integration.id = configuration.integration_id
      WHERE configuration.tenant_id = $1 AND configuration.integration_id = $2`,
    values: [tenantId, integrationId],
  });
  return record(result.rows[0], registry);
}

async function lockActor(client, input) {
  const tenant = await client.query({
    name: 'catering-configuration-tenant-lock',
    text: `SELECT id FROM tenants WHERE id = $1 AND status IN ('pending', 'onboarding', 'ready', 'active') FOR SHARE`,
    values: [input.tenantId],
  });
  if (tenant.rowCount !== 1) return false;
  const user = await client.query({
    name: 'catering-configuration-actor-lock',
    text: `SELECT id FROM users WHERE tenant_id = $1 AND id = $2 AND active = true AND security_version = $3 FOR SHARE`,
    values: [input.tenantId, input.actorUserId, input.expectedSecurityVersion],
  });
  if (user.rowCount !== 1) return false;
  const session = await client.query({
    name: 'catering-configuration-session-lock',
    text: `SELECT id FROM sessions WHERE tenant_id = $1 AND user_id = $2 AND id = $3
      AND principal_version = $4 AND revoked_at IS NULL AND expires_at > clock_timestamp()
      AND roles @> ARRAY['tenant_admin']::text[] AND permissions @> ARRAY['tenant:integrations:manage']::text[] FOR SHARE`,
    values: [input.tenantId, input.actorUserId, input.sessionId, input.expectedSecurityVersion],
  });
  return session.rowCount === 1;
}

export function createPostgresCateringConfigurationRepository(pool, { registry, auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!registry || typeof registry.get !== 'function') throw new TypeError('PROVIDER_REGISTRY_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');

  async function write(value, initialize) {
    const input = {
      ...value, tenantId: uuid(value?.tenantId), integrationId: uuid(value?.integrationId),
      actorUserId: uuid(value?.actorUserId), sessionId: uuid(value?.sessionId), correlationId: uuid(value?.correlationId),
    };
    counter(input.expectedSecurityVersion);
    if (initialize && input.expectedRevision !== 0) throw new TypeError('CATERING_CONFIGURATION_VERSION_INVALID');
    const expected = initialize ? 0 : counter(input.expectedRevision);
    const revision = initialize ? 1 : counter(expected + 1);
    if (!(input.changedAt instanceof Date) || !Number.isFinite(input.changedAt.getTime())
      || typeof input.auditEventFor !== 'function') throw new TypeError('CATERING_CONFIGURATION_WRITE_INVALID');
    const configuration = normalizeCateringConfiguration(input.configuration, registry.get(input.providerId));
    const modes = MODES.map((mode) => configuration.capabilities[`catering.${mode}`]);
    return withPostgresTransaction(pool, async (client) => {
      if (!await lockActor(client, input)) return Object.freeze({ status: 'not_authorized' });
      const integration = await client.query({
        name: 'catering-configuration-integration-lock',
        text: 'SELECT provider FROM integrations WHERE tenant_id = $1 AND id = $2 AND provider = $3 FOR UPDATE',
        values: [input.tenantId, input.integrationId, input.providerId],
      });
      if (integration.rowCount !== 1) return Object.freeze({ status: 'not_found' });
      const current = await load(client, input.tenantId, input.integrationId, registry);
      if ((initialize && current) || (!initialize && current && current.revision !== expected)) {
        return Object.freeze({ status: 'conflict', currentRevision: current.revision });
      }
      if (!initialize && !current) return Object.freeze({ status: 'not_found' });
      const values = [input.tenantId, input.integrationId, revision, configuration.initialOrderMode, ...modes,
        input.changedAt, input.actorUserId];
      const result = initialize ? await client.query({
        name: 'catering-configuration-initialize',
        text: `INSERT INTO catering_integration_configurations (
          tenant_id, integration_id, revision, initial_order_mode, catalogue_mode, availability_mode,
          order_mode, update_mode, cancel_mode, status_mode, created_at, updated_at, updated_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)`,
        values,
      }) : await client.query({
        name: 'catering-configuration-update',
        text: `UPDATE catering_integration_configurations SET revision=$3, initial_order_mode=$4,
          catalogue_mode=$5, availability_mode=$6, order_mode=$7, update_mode=$8, cancel_mode=$9, status_mode=$10,
          updated_at=$11, updated_by_user_id=$12 WHERE tenant_id=$1 AND integration_id=$2 AND revision=$13`,
        values: [...values, expected],
      });
      if (result.rowCount !== 1) throw new Error('CATERING_CONFIGURATION_WRITE_FAILED');
      const snapshot = await client.query({
        name: 'catering-configuration-snapshot',
        text: `INSERT INTO catering_integration_configuration_revisions SELECT configuration.*, $4::uuid
          FROM catering_integration_configurations configuration WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3`,
        values: [input.tenantId, input.integrationId, revision, input.correlationId],
      });
      if (snapshot.rowCount !== 1) throw new Error('CATERING_CONFIGURATION_SNAPSHOT_FAILED');
      const event = input.auditEventFor({ revision });
      if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId
        || event.correlationId !== input.correlationId || event.targetType !== 'integration'
        || event.targetId !== input.integrationId || event.action !== 'tenant.configuration.changed'
        || event.outcome !== 'success' || event.retentionClass !== 'administrative'
        || event.newState?.revision !== revision || event.previousState?.revision !== expected
        || JSON.stringify(event.metadata) !== JSON.stringify({
          operation: initialize ? 'catering_configuration_initialize' : 'catering_configuration_update',
        })) {
        throw new Error('CATERING_CONFIGURATION_AUDIT_SCOPE_INVALID');
      }
      if (!await auditRepository.appendWithClient(client, event)) throw new Error('AUDIT_APPEND_FAILED');
      return Object.freeze({ status: 'updated', current: await load(client, input.tenantId, input.integrationId, registry) });
    });
  }

  return Object.freeze({
    async loadCurrent({ tenantId, integrationId }) {
      return load(pool, uuid(tenantId), uuid(integrationId), registry);
    },
    initialize: (value) => write(value, true),
    update: (value) => write(value, false),
  });
}
