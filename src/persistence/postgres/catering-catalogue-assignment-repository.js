import { isInternalUuid } from '../../domain/identifiers.js';
import {
  cateringCatalogueAssignmentConnectionIds, normalizeCateringCatalogueAssignments,
} from '../../domain/catering-catalogue-assignments.js';
import { normalizeTenantCatalogue } from '../../domain/tenant-catalogue.js';
import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';
import { withPostgresTransaction } from './transaction.js';

const MODES = ['catalogue', 'availability', 'order', 'update', 'cancel', 'status'];
function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CATERING_ASSIGNMENT_IDENTIFIER_INVALID');
  return value.toLowerCase();
}
function counter(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_ASSIGNMENT_REVISION_INVALID');
  }
  return value;
}
async function catalogueState(client, tenantId, lock = false) {
  const result = await client.query({
    name: lock ? 'catering-assignment-catalogue-lock' : 'catering-assignment-catalogue-read',
    text: `SELECT tenant.catalog_revision, catalogue.snapshot FROM tenants tenant
      JOIN tenant_catalogue_revisions catalogue ON catalogue.tenant_id=tenant.id AND catalogue.revision=tenant.catalog_revision
      WHERE tenant.id=$1 ${lock ? 'FOR UPDATE OF tenant' : ''}`, values: [tenantId],
  });
  if (result.rows.length !== 1) return null;
  return { catalogueRevision: counter(Number(result.rows[0].catalog_revision)),
    catalogue: normalizeTenantCatalogue(result.rows[0].snapshot) };
}
async function actorAvailable(client, input) {
  const tenant = await client.query({
    name: 'catering-assignment-tenant-lock', text: "SELECT id FROM tenants WHERE id=$1 AND status='active' FOR UPDATE",
    values: [input.tenantId],
  });
  if (tenant.rowCount !== 1) return false;
  const user = await client.query({
    name: 'catering-assignment-user-lock',
    text: 'SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND active=true AND security_version=$3 FOR SHARE',
    values: [input.tenantId, input.actorUserId, input.expectedSecurityVersion],
  });
  if (user.rowCount !== 1) return false;
  const session = await client.query({
    name: 'catering-assignment-session-lock',
    text: `SELECT id FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND principal_version=$4
      AND revoked_at IS NULL AND expires_at>clock_timestamp() AND roles @> ARRAY['conference_manager']::text[]
      AND permissions @> ARRAY['tenant:catalogue:manage']::text[] FOR SHARE`,
    values: [input.tenantId, input.actorUserId, input.sessionId, input.expectedSecurityVersion],
  });
  return session.rowCount === 1;
}
function connectionValue(row, registry) {
  const normalized = normalizeCateringConfiguration({ initialOrderMode: row.initial_order_mode,
    capabilities: Object.fromEntries(MODES.map((mode) => [`catering.${mode}`, row[`${mode}_mode`]])) }, registry.get(row.provider));
  return Object.freeze({ tenantId: row.tenant_id, integrationId: uuid(row.integration_id), providerId: normalized.providerId,
    eligible: ['configured', 'active'].includes(row.status)
      && Object.values(normalized.capabilities).some((mode) => mode !== 'unsupported') });
}
async function bindings(client, tenantId, integrationIds, registry, lock = false) {
  if (integrationIds.length === 0) return [];
  if (integrationIds.length > 400) throw new TypeError('CATERING_ASSIGNMENT_CONNECTION_BOUND_INVALID');
  const result = await client.query({
    name: lock ? 'catering-assignment-connections-lock' : 'catering-assignment-connections-read',
    text: `SELECT configuration.*, integration.provider, integration.status FROM catering_integration_configurations configuration
      JOIN integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
      WHERE configuration.tenant_id=$1 AND configuration.integration_id=ANY($2::uuid[])
      ORDER BY configuration.integration_id ${lock ? 'FOR SHARE OF configuration, integration' : ''}`,
    values: [tenantId, integrationIds],
  });
  return result.rows.map((row) => connectionValue(row, registry));
}
async function current(client, tenantId, registry) {
  const state = await catalogueState(client, tenantId);
  if (!state) return null;
  const result = await client.query({
    name: 'catering-assignment-head-read',
    text: `SELECT head.revision, history.catalogue_revision, catalogue.snapshot FROM catering_catalogue_assignment_heads head
      JOIN catering_catalogue_assignment_revisions history ON history.tenant_id=head.tenant_id AND history.revision=head.revision
      JOIN tenant_catalogue_revisions catalogue ON catalogue.tenant_id=history.tenant_id AND catalogue.revision=history.catalogue_revision
      WHERE head.tenant_id=$1`, values: [tenantId],
  });
  if (result.rows.length === 0) return Object.freeze({ tenantId, revision: 0,
    currentCatalogueRevision: state.catalogueRevision, assignedCatalogueRevision: null, assignments: Object.freeze([]), stale: true });
  const row = result.rows[0];
  const entries = await client.query({ name: 'catering-assignment-entries-read',
    text: `SELECT kind, entry_id, integration_id FROM catering_catalogue_assignment_entries
      WHERE tenant_id=$1 AND revision=$2 ORDER BY kind,entry_id`, values: [tenantId, row.revision] });
  const proposal = { schemaVersion: 1, catalogueRevision: counter(Number(row.catalogue_revision)),
    assignments: entries.rows.map((entry) => ({ kind: entry.kind, entryId: entry.entry_id, integrationId: entry.integration_id })) };
  const connections = await bindings(client, tenantId, cateringCatalogueAssignmentConnectionIds(proposal), registry);
  const normalized = normalizeCateringCatalogueAssignments(proposal, { tenantId, catalogueRevision: proposal.catalogueRevision,
    catalogue: row.snapshot, connections: connections.map(({ integrationId }) => ({ tenantId, integrationId })) });
  return Object.freeze({ tenantId, revision: counter(Number(row.revision)), currentCatalogueRevision: state.catalogueRevision,
    assignedCatalogueRevision: normalized.catalogueRevision, assignments: normalized.assignments,
    stale: normalized.catalogueRevision !== state.catalogueRevision || connections.some((entry) => !entry.eligible) });
}

export function createPostgresCateringCatalogueAssignmentRepository(pool, { registry, auditRepository } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!registry || typeof registry.get !== 'function') throw new TypeError('PROVIDER_REGISTRY_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  return Object.freeze({
    loadCurrent({ tenantId }) {
      return withPostgresTransaction(pool, (client) => current(client, uuid(tenantId), registry),
        { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
    loadProposalInputs({ tenantId, proposal }) {
      const tenant = uuid(tenantId);
      const ids = cateringCatalogueAssignmentConnectionIds(proposal);
      return withPostgresTransaction(pool, async (client) => {
        const state = await catalogueState(client, tenant);
        if (!state) return null;
        const connections = await bindings(client, tenant, ids, registry);
        return Object.freeze({ tenantId: tenant, ...state,
          connections: Object.freeze(connections.filter((entry) => entry.eligible)
            .map(({ integrationId }) => ({ tenantId: tenant, integrationId }))) });
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
    async listConnections({ tenantId, afterIntegrationId = null }) {
      const tenant = uuid(tenantId);
      const after = afterIntegrationId === null ? null : uuid(afterIntegrationId);
      const result = await pool.query({ name: 'catering-assignment-eligible-connections',
        text: `SELECT configuration.*, integration.provider, integration.status FROM catering_integration_configurations configuration
          JOIN integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
          WHERE configuration.tenant_id=$1 AND ($2::uuid IS NULL OR configuration.integration_id>$2::uuid)
          AND integration.status IN ('configured','active') AND (catalogue_mode<>'unsupported' OR availability_mode<>'unsupported'
            OR order_mode<>'unsupported' OR update_mode<>'unsupported' OR cancel_mode<>'unsupported' OR status_mode<>'unsupported')
          ORDER BY configuration.integration_id LIMIT 21`, values: [tenant, after] });
      const rows = result.rows.map((row) => connectionValue(row, registry));
      if (rows.some((row) => !row.eligible)) throw new TypeError('CATERING_ASSIGNMENT_CONNECTION_PAGE_INVALID');
      return Object.freeze({
        items: Object.freeze(rows.slice(0, 20).map(({ integrationId, providerId }) => ({ integrationId, providerId }))),
        nextAfterIntegrationId: rows.length > 20 ? rows[19].integrationId : null });
    },
    async replace(value) {
      const input = { ...value, tenantId: uuid(value?.tenantId), actorUserId: uuid(value?.actorUserId),
        sessionId: uuid(value?.sessionId), correlationId: uuid(value?.correlationId) };
      const expected = counter(input.expectedRevision, 0);
      const revision = counter(expected + 1);
      counter(input.expectedSecurityVersion);
      if (!(input.changedAt instanceof Date) || !Number.isFinite(input.changedAt.getTime())
        || typeof input.auditEventFor !== 'function') throw new TypeError('CATERING_ASSIGNMENT_WRITE_INVALID');
      const ids = cateringCatalogueAssignmentConnectionIds(input.proposal);
      return withPostgresTransaction(pool, async (client) => {
        if (!await actorAvailable(client, input)) return Object.freeze({ status: 'not_authorized' });
        const state = await catalogueState(client, input.tenantId, true);
        if (input.proposal.catalogueRevision !== state.catalogueRevision) {
          return Object.freeze({ status: 'catalogue_conflict', currentRevision: state.catalogueRevision });
        }
        const head = await client.query({ name: 'catering-assignment-head-lock',
          text: 'SELECT revision FROM catering_catalogue_assignment_heads WHERE tenant_id=$1 FOR UPDATE', values: [input.tenantId] });
        const previous = head.rows[0] ? counter(Number(head.rows[0].revision)) : 0;
        if (previous !== expected) return Object.freeze({ status: 'conflict', currentRevision: previous });
        const connections = await bindings(client, input.tenantId, ids, registry, true);
        const normalized = normalizeCateringCatalogueAssignments(input.proposal, { tenantId: input.tenantId, ...state,
          connections: connections.filter((entry) => entry.eligible)
            .map(({ integrationId }) => ({ tenantId: input.tenantId, integrationId })) });
        const created = await client.query({ name: 'catering-assignment-revision-insert',
          text: `INSERT INTO catering_catalogue_assignment_revisions
            (tenant_id,revision,catalogue_revision,entry_count,changed_at,changed_by_user_id,correlation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, values: [input.tenantId, revision, state.catalogueRevision,
            normalized.assignments.length, input.changedAt, input.actorUserId, input.correlationId] });
        const entries = await client.query({ name: 'catering-assignment-entries-insert',
          text: `INSERT INTO catering_catalogue_assignment_entries (tenant_id,revision,kind,entry_id,integration_id)
            SELECT $1,$2,kind,entry_id,integration_id FROM unnest($3::text[],$4::text[],$5::uuid[]) entry(kind,entry_id,integration_id)`,
          values: [input.tenantId, revision, normalized.assignments.map((entry) => entry.kind),
            normalized.assignments.map((entry) => entry.entryId), normalized.assignments.map((entry) => entry.integrationId)] });
        const moved = expected === 0 ? await client.query({ name: 'catering-assignment-head-insert',
          text: 'INSERT INTO catering_catalogue_assignment_heads (tenant_id,revision) VALUES ($1,$2)', values: [input.tenantId, revision] })
          : await client.query({ name: 'catering-assignment-head-update',
            text: 'UPDATE catering_catalogue_assignment_heads SET revision=$2 WHERE tenant_id=$1 AND revision=$3',
            values: [input.tenantId, revision, expected] });
        if (created.rowCount !== 1 || entries.rowCount !== normalized.assignments.length || moved.rowCount !== 1) {
          throw new Error('CATERING_ASSIGNMENT_WRITE_FAILED');
        }
        const event = input.auditEventFor({ revision, catalogueRevision: state.catalogueRevision });
        if (event?.tenantId !== input.tenantId || event.actorUserId !== input.actorUserId || event.correlationId !== input.correlationId
          || event.action !== 'tenant.configuration.changed' || event.targetType !== 'tenant_configuration'
          || event.targetId !== 'catering_catalogue_assignments' || event.outcome !== 'success' || event.retentionClass !== 'administrative'
          || event.previousState?.revision !== expected || event.newState?.revision !== revision
          || event.newState?.catalogueRevision !== state.catalogueRevision
          || JSON.stringify(event.metadata) !== JSON.stringify({ operation: 'catering_catalogue_assignment_replace' })) {
          throw new Error('CATERING_ASSIGNMENT_AUDIT_SCOPE_INVALID');
        }
        if (!await auditRepository.appendWithClient(client, event)) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({ status: 'updated', current: await current(client, input.tenantId, registry) });
      });
    },
  });
}
