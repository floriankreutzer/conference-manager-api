import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeCateringProviderCatalogue, normalizeCateringProviderCatalogueMetadata,
  normalizeCateringProviderCatalogueReceiptCommand } from '../../domain/catering-provider-catalogue.js';
import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';
import { lockCateringCatalogueManager } from './catering-catalogue-manager-session.js';
import { readCurrentCateringConnectionWithClient } from './catering-current-connection.js';
import { withPostgresTransaction } from './transaction.js';

const MODES = ['catalogue','availability','order','update','cancel','status'];
const RECEIPT_COLUMNS = `tenant_id,integration_id,provider_id,command_id,revision,configuration_revision,
  reference,recorded_at,recorded_by_user_id,actor_security_version,source`;
const result = (status, value = {}) => Object.freeze({ status, ...value });
function invalid() { throw new TypeError('CATERING_PROVIDER_CATALOGUE_PERSISTENCE_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function count(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid(); return value;
}
function document(value, scope) {
  const normalized = normalizeCateringProviderCatalogue(value, scope);
  return Object.freeze({ schemaVersion: 1, sourceVersion: normalized.sourceVersion,
    items: normalized.items, packages: normalized.packages, terms: normalized.terms });
}
function receipt(row, scope, registry) {
  if (row.tenant_id !== scope.tenantId || row.integration_id !== scope.integrationId
    || registry.get(row.provider_id).id !== row.provider_id) invalid();
  return Object.freeze({ ...scope, providerId: row.provider_id, commandId: uuid(row.command_id), revision: count(Number(row.revision)),
    configurationRevision: count(Number(row.configuration_revision)), reference: row.reference,
    recordedAt: row.recorded_at.toISOString(), actorUserId: uuid(row.recorded_by_user_id),
    actorSecurityVersion: count(Number(row.actor_security_version)), source: document(row.source, scope) });
}
function sameCommand(saved, input) {
  return saved.integrationId === input.integrationId && saved.commandId === input.command.commandId
    && saved.actorUserId === input.actorUserId && saved.actorSecurityVersion === input.expectedSecurityVersion
    && saved.revision === input.command.expectedRevision + 1
    && saved.configurationRevision === input.command.expectedConfigurationRevision
    && saved.reference === input.command.reference && JSON.stringify(saved.source) === JSON.stringify(input.command.source);
}

export function createPostgresCateringProviderCatalogueRepository(pool, { registry, auditRepository } = {}) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function' || typeof registry?.get !== 'function'
    || typeof auditRepository?.appendWithClient !== 'function') throw new TypeError('CATERING_PROVIDER_CATALOGUE_PERSISTENCE_REQUIRED');
  return Object.freeze({
    async listConnections({ tenantId,afterIntegrationId = null }) {
      const tenant = uuid(tenantId); const after = afterIntegrationId === null ? null : uuid(afterIntegrationId);
      const result = await pool.query({ name: 'catering-provider-catalogue-connections-read',
        text: `SELECT configuration.tenant_id,configuration.integration_id,configuration.revision,configuration.initial_order_mode,
          configuration.catalogue_mode,configuration.availability_mode,configuration.order_mode,configuration.update_mode,
          configuration.cancel_mode,configuration.status_mode,integration.provider,
          integration.status IN ('configured','active') AS connection_available,coalesce(head.revision,0) AS current_revision
          FROM catering_integration_configurations configuration JOIN integrations integration
            ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
          LEFT JOIN catering_provider_catalogue_heads head
            ON head.tenant_id=configuration.tenant_id AND head.integration_id=configuration.integration_id
          WHERE configuration.tenant_id=$1 AND ($2::uuid IS NULL OR configuration.integration_id>$2::uuid)
            AND (configuration.catalogue_mode<>'unsupported' OR head.revision IS NOT NULL)
          ORDER BY configuration.integration_id LIMIT 21`,values: [tenant,after] });
      if (result.rows.length > 21) invalid();
      return Object.freeze(result.rows.map((row) => {
        if (row.tenant_id !== tenant) invalid();
        const configuration = normalizeCateringConfiguration({ initialOrderMode: row.initial_order_mode,
          capabilities: Object.fromEntries(MODES.map((name) => [`catering.${name}`,row[`${name}_mode`]])) },registry.get(row.provider));
        return Object.freeze({ tenantId: tenant,integrationId: uuid(row.integration_id),providerId: configuration.providerId,
          configurationRevision: count(Number(row.revision)),configuration: Object.freeze({
            initialOrderMode: configuration.initialOrderMode,capabilities: configuration.capabilities }),
          connectionAvailable: row.connection_available,currentRevision: count(Number(row.current_revision),0) });
      }));
    },
    async load({ tenantId, integrationId, beforeRevision = null }) {
      const scope = { tenantId: uuid(tenantId), integrationId: uuid(integrationId) };
      const before = beforeRevision === null ? null : count(beforeRevision);
      return withPostgresTransaction(pool, async (client) => {
        const headers = await client.query({ name: 'catering-provider-catalogue-configuration-read',
          text: `SELECT configuration.tenant_id,configuration.integration_id,configuration.revision,configuration.initial_order_mode,
            configuration.catalogue_mode,configuration.availability_mode,configuration.order_mode,configuration.update_mode,
            configuration.cancel_mode,configuration.status_mode,integration.provider,
            integration.status IN ('configured','active') AS connection_available,coalesce(head.revision,0) AS current_revision
            FROM catering_integration_configurations configuration JOIN integrations integration
              ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
            LEFT JOIN catering_provider_catalogue_heads head
              ON head.tenant_id=configuration.tenant_id AND head.integration_id=configuration.integration_id
            WHERE configuration.tenant_id=$1 AND configuration.integration_id=$2`, values: [scope.tenantId,scope.integrationId] });
        if (headers.rowCount === 0) return null; if (headers.rowCount !== 1) invalid();
        const header = headers.rows[0];
        if (header.tenant_id !== scope.tenantId || header.integration_id !== scope.integrationId) invalid();
        const configuration = normalizeCateringConfiguration({ initialOrderMode: header.initial_order_mode,
          capabilities: Object.fromEntries(MODES.map((name) => [`catering.${name}`, header[`${name}_mode`]])) },
        registry.get(header.provider));
        const page = await client.query({ name: 'catering-provider-catalogue-history-read',
          text: `SELECT tenant_id,integration_id,provider_id,revision,configuration_revision,reference,recorded_at,
            source->'sourceVersion' AS source_version,source->'terms' AS terms,
            jsonb_array_length(source->'items') AS item_count,jsonb_array_length(source->'packages') AS package_count
            FROM catering_provider_catalogue_revisions
            WHERE tenant_id=$1 AND integration_id=$2 AND ($3::bigint IS NULL OR revision<$3)
            ORDER BY revision DESC LIMIT 21`, values: [scope.tenantId,scope.integrationId,before] });
        const all = page.rows.map((row) => {
          if (row.tenant_id !== scope.tenantId || row.integration_id !== scope.integrationId
            || row.provider_id !== header.provider) invalid();
          return Object.freeze({ revision: count(Number(row.revision)), configurationRevision: count(Number(row.configuration_revision)),
            reference: row.reference, recordedAt: row.recorded_at.toISOString(), summary: normalizeCateringProviderCatalogueMetadata({
              sourceVersion: row.source_version, terms: row.terms, itemCount: row.item_count, packageCount: row.package_count }) });
        });
        const revisions = all.slice(0,20);
        return Object.freeze({ ...scope, providerId: header.provider, configurationRevision: count(Number(header.revision)),
          configuration: Object.freeze({ initialOrderMode: configuration.initialOrderMode, capabilities: configuration.capabilities }),
          connectionAvailable: header.connection_available, currentRevision: count(Number(header.current_revision),0),
          revisions: Object.freeze(revisions), nextBeforeRevision: all.length > 20 ? revisions.at(-1).revision : null });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
    async loadRevision({ tenantId, integrationId, revision }) {
      const scope = { tenantId: uuid(tenantId), integrationId: uuid(integrationId) }; revision = count(revision);
      const rows = await pool.query({ name: 'catering-provider-catalogue-source-read',
        text: `SELECT ${RECEIPT_COLUMNS} FROM catering_provider_catalogue_revisions
          WHERE tenant_id=$1 AND integration_id=$2 AND revision=$3`, values: [scope.tenantId,scope.integrationId,revision] });
      if (rows.rowCount === 0) return null; if (rows.rowCount !== 1) invalid();
      return receipt(rows.rows[0],scope,registry);
    },
    async receive(value) {
      const scope = { tenantId: uuid(value?.tenantId), integrationId: uuid(value?.integrationId) };
      const input = { ...value, ...scope, actorUserId: uuid(value?.actorUserId), sessionId: uuid(value?.sessionId),
        correlationId: uuid(value?.correlationId), expectedSecurityVersion: count(value?.expectedSecurityVersion),
        command: normalizeCateringProviderCatalogueReceiptCommand(value?.command, scope) };
      if (typeof input.auditEventFor !== 'function') invalid();
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockCateringCatalogueManager(client, input)) return result('not_authorized');
        const prior = await client.query({ name: 'catering-provider-catalogue-command-read',
          text: `SELECT ${RECEIPT_COLUMNS} FROM catering_provider_catalogue_revisions WHERE tenant_id=$1 AND command_id=$2`,
          values: [input.tenantId,input.command.commandId] });
        if (prior.rowCount > 1) invalid();
        if (prior.rowCount === 1) {
          if (prior.rows[0].integration_id !== input.integrationId) return result('command_conflict');
          const saved = receipt(prior.rows[0], scope, registry);
          return sameCommand(saved,input) ? result('recorded', { replayed: true, receipt: saved }) : result('command_conflict');
        }
        const configuration = await readCurrentCateringConnectionWithClient(client, input.tenantId, input.integrationId, registry);
        if (configuration === null) return result('not_found');
        if (configuration.revision !== input.command.expectedConfigurationRevision) return result('configuration_conflict');
        if (configuration.capabilities['catering.catalogue'] !== 'manual') return result('source_unavailable');
        const heads = await client.query({ name: 'catering-provider-catalogue-head-lock',
          text: 'SELECT revision FROM catering_provider_catalogue_heads WHERE tenant_id=$1 AND integration_id=$2 FOR UPDATE',
          values: [input.tenantId,input.integrationId] });
        if (heads.rowCount > 1) invalid();
        const current = heads.rowCount === 0 ? 0 : count(Number(heads.rows[0].revision));
        if (current !== input.command.expectedRevision) return result('conflict');
        const revision = count(current + 1);
        const created = await client.query({ name: 'catering-provider-catalogue-source-insert',
          text: `INSERT INTO catering_provider_catalogue_revisions
            (tenant_id,integration_id,revision,configuration_revision,command_id,provider_id,reference,attest_received_from_supplier,
              source,recorded_by_user_id,actor_security_version,correlation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8::jsonb,$9,$10,$11) RETURNING ${RECEIPT_COLUMNS}`,
          values: [input.tenantId,input.integrationId,revision,configuration.revision,input.command.commandId,configuration.providerId,
            input.command.reference,JSON.stringify(input.command.source),input.actorUserId,input.expectedSecurityVersion,
            input.correlationId] });
        if (created.rowCount !== 1) invalid();
        const moved = current === 0 ? await client.query({ name: 'catering-provider-catalogue-head-insert',
          text: 'INSERT INTO catering_provider_catalogue_heads (tenant_id,integration_id,revision) VALUES ($1,$2,$3)',
          values: [input.tenantId,input.integrationId,revision] }) : await client.query({ name: 'catering-provider-catalogue-head-update',
          text: 'UPDATE catering_provider_catalogue_heads SET revision=$3 WHERE tenant_id=$1 AND integration_id=$2 AND revision=$4',
          values: [input.tenantId,input.integrationId,revision,current] });
        if (moved.rowCount !== 1) invalid();
        const event = input.auditEventFor({ revision, configurationRevision: configuration.revision });
        if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId || event.correlationId !== input.correlationId
          || event.action !== 'catering.catalogue.received' || event.targetType !== 'integration' || event.targetId !== input.integrationId
          || event.outcome !== 'success' || event.retentionClass !== 'business'
          || JSON.stringify(event.previousState) !== JSON.stringify({ revision: current })
          || JSON.stringify(event.newState) !== JSON.stringify({ configurationRevision: configuration.revision, revision })
          || JSON.stringify(event.metadata) !== JSON.stringify({ itemCount: input.command.source.items.length,
            operation: 'catering_provider_catalogue_receive', packageCount: input.command.source.packages.length, source: 'manual' })) {
          throw new TypeError('CATERING_PROVIDER_CATALOGUE_AUDIT_SCOPE_INVALID');
        }
        if (!await auditRepository.appendWithClient(client, event)) throw new Error('AUDIT_APPEND_FAILED');
        return result('recorded', { replayed: false, receipt: receipt(created.rows[0],scope,registry) });
      });
    },
  });
}
