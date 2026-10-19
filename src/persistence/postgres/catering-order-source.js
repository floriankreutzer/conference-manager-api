import { isInternalUuid } from '../../domain/identifiers.js';
import { isRequestId, normalizePublicRequest, normalizeRequest } from '../../domain/request.js';
import { createCateringOrderSnapshots } from '../../domain/catering-order-snapshot.js';
import { normalizeCateringOrderTotal } from '../../domain/catering-order-money.js';
import { isCateringOrderStatus } from '../../domain/catering-order-state.js';

function invalid() { throw new TypeError('CATERING_ORDER_PERSISTED_SOURCE_INVALID'); }
function positive(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) invalid();
  return number;
}
function uuid(value) {
  if (!isInternalUuid(value)) invalid();
  return value.toLowerCase();
}
function historicalRequest(row) {
  const publicRecord = normalizePublicRequest({ ...row.record,
    requesterAttribution: { displayName: row.requester_display_name } }, {
    tenantId: row.tenant_id, requesterUserId: row.requester_user_id,
  });
  const snapshot = publicRecord.schemaVersion === 1 ? null : {
    schemaVersion: publicRecord.schemaVersion, requestVersion: publicRecord.version,
    capturedAt: publicRecord.allocations.snapshottedAt, configurationRevisions: publicRecord.configurationRevisions,
    details: publicRecord.details, pricing: publicRecord.pricing, policy: publicRecord.policy, allocations: publicRecord.allocations,
  };
  return normalizeRequest({ ...publicRecord, tenantId: row.tenant_id, requesterUserId: row.requester_user_id, snapshot });
}

export async function loadCateringOrderSourceWithClient(client, { tenantId, requestId, requestVersion, assignmentRevision }) {
  tenantId = uuid(tenantId);
  if (!isRequestId(requestId)) invalid();
  positive(requestVersion); positive(assignmentRevision);
  const result = await client.query({ name: 'catering-order-historical-request',
    text: `SELECT revision.tenant_id,revision.record,request.requester_user_id,request.requester_display_name
      FROM request_revisions revision JOIN requests request ON request.tenant_id=revision.tenant_id AND request.id=revision.request_id
      WHERE revision.tenant_id=$1 AND revision.request_id=$2 AND revision.request_version=$3`,
    values: [tenantId, requestId, requestVersion] });
  if (result.rowCount !== 1) return null;
  const request = historicalRequest(result.rows[0]);
  if (request.tenantId !== tenantId || request.id !== requestId || request.version !== requestVersion) invalid();
  if (request.snapshot === null) return null;
  const ownership = await client.query({ name: 'catering-order-historical-ownership',
    text: `SELECT history.catalogue_revision,catalogue.snapshot FROM catering_catalogue_assignment_revisions history
      JOIN catering_catalogue_assignment_seals seal ON seal.tenant_id=history.tenant_id AND seal.revision=history.revision
      JOIN tenant_catalogue_revisions catalogue ON catalogue.tenant_id=history.tenant_id AND catalogue.revision=history.catalogue_revision
      WHERE history.tenant_id=$1 AND history.revision=$2`, values: [tenantId, assignmentRevision] });
  if (ownership.rowCount !== 1) return null;
  const catalogueRevision = positive(ownership.rows[0].catalogue_revision);
  if (catalogueRevision !== request.snapshot.configurationRevisions.catalogue) return null;
  const entries = await client.query({ name: 'catering-order-historical-ownership-entries',
    text: `SELECT kind,entry_id,integration_id FROM catering_catalogue_assignment_entries
      WHERE tenant_id=$1 AND revision=$2 ORDER BY kind,entry_id LIMIT 401`, values: [tenantId, assignmentRevision] });
  if (entries.rowCount > 400) invalid();
  const assignments = entries.rows.map((row) => ({ kind: row.kind, entryId: row.entry_id, integrationId: uuid(row.integration_id) }));
  // These are independently loaded immutable same-Tenant FK references, not
  // proof of current delivery eligibility. Mutations recheck current connections.
  const connections = [...new Set(assignments.map((entry) => entry.integrationId))]
    .map((integrationId) => ({ tenantId, integrationId }));
  return Object.freeze({ request, assignmentRevision, ownership: { schemaVersion: 1, catalogueRevision, assignments },
    canonicalCatalogue: ownership.rows[0].snapshot, connections });
}

export async function readCateringOrderWithClient(client, { tenantId, orderId, version = null, registry, lock = false }) {
  tenantId = uuid(tenantId); orderId = uuid(orderId);
  if (version !== null) positive(version);
  const result = await client.query({ name: lock ? 'catering-order-detail-lock' : 'catering-order-detail-read',
    text: `SELECT history.*,integration.provider,state.revision AS state_revision,state.status,
      state.updated_at AS state_updated_at,state.quote_revision,state.decision_sequence,
      quote.amount_minor AS quote_amount_minor,quote.currency AS quote_currency,quote.expires_at,
      decision.decision,decision.quote_revision AS decision_quote_revision,
      decision.amount_minor AS decision_amount_minor,decision.currency AS decision_currency,
      decision.decider_user_id,decision.decider_security_version,clock_timestamp() AS observed_at
      FROM catering_orders owned JOIN catering_order_heads head ON head.tenant_id=owned.tenant_id AND head.order_id=owned.id
      JOIN catering_order_versions history ON history.tenant_id=owned.tenant_id AND history.order_id=owned.id
        AND history.version=coalesce($3::bigint,head.current_version)
      JOIN catering_order_version_seals seal ON seal.tenant_id=history.tenant_id AND seal.order_id=history.order_id
        AND seal.version=history.version
      JOIN catering_order_version_states state ON state.tenant_id=history.tenant_id AND state.order_id=history.order_id
        AND state.version=history.version
      JOIN integrations integration ON integration.tenant_id=owned.tenant_id AND integration.id=owned.integration_id
      LEFT JOIN catering_order_quotes quote ON quote.tenant_id=state.tenant_id AND quote.order_id=state.order_id
        AND quote.version=state.version AND quote.revision=state.quote_revision
      LEFT JOIN catering_order_decisions decision ON decision.tenant_id=state.tenant_id AND decision.order_id=state.order_id
        AND decision.version=state.version AND decision.sequence=state.decision_sequence
      WHERE owned.tenant_id=$1 AND owned.id=$2 ${lock ? 'FOR UPDATE OF state' : ''}`,
    values: [tenantId, orderId, version] });
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  if (row.tenant_id !== tenantId || row.order_id !== orderId || !isCateringOrderStatus(row.status)
    || !['initial','change','cancel','exception'].includes(row.operation)) invalid();
  const orderVersion = positive(row.version);
  const source = await loadCateringOrderSourceWithClient(client, { tenantId, requestId: row.request_id,
    requestVersion: positive(row.request_version), assignmentRevision: positive(row.assignment_revision) });
  if (!source || source.request.snapshot.configurationRevisions.catalogue !== positive(row.catalogue_revision)) invalid();
  const positions = await client.query({ name: 'catering-order-persisted-positions',
    text: `SELECT position_id,kind,entry_id FROM catering_order_positions
      WHERE tenant_id=$1 AND order_id=$2 AND version=$3 ORDER BY kind,entry_id LIMIT 102`,
    values: [tenantId, orderId, orderVersion] });
  if (positions.rowCount < 1 || positions.rowCount > 101 || positions.rowCount !== Number(row.position_count)) invalid();
  const identities = new Map(positions.rows.map((entry) => [`${entry.kind}:${entry.entry_id}`, uuid(entry.position_id)]));
  const [snapshot] = createCateringOrderSnapshots({ ...source, orderVersion, onlyIntegrationId: row.integration_id,
    orderIdFactory: () => orderId, positionIdFactory: ({ kind, entryId }) => identities.get(`${kind}:${entryId}`) });
  if (!snapshot || snapshot.positions.length !== positions.rowCount
    || snapshot.conferencePrice.amountMinor !== Number(row.conference_total_minor)
    || snapshot.conferencePrice.currency !== row.currency) invalid();
  const provider = registry.get(row.provider);
  const quote = row.quote_revision === null ? null : Object.freeze({ revision: positive(row.quote_revision),
    cost: normalizeCateringOrderTotal({ amountMinor: Number(row.quote_amount_minor), currency: row.quote_currency }),
    expiresAt: row.expires_at.toISOString(), expired: row.expires_at.getTime() <= row.observed_at.getTime() });
  const decision = row.decision_sequence === null ? null : Object.freeze({ sequence: positive(row.decision_sequence),
    decision: row.decision, quoteRevision: positive(row.decision_quote_revision),
    cost: normalizeCateringOrderTotal({ amountMinor: Number(row.decision_amount_minor), currency: row.decision_currency }),
    deciderUserId: uuid(row.decider_user_id), securityVersion: positive(row.decider_security_version) });
  if (decision && (!quote || !['approved','rejected'].includes(decision.decision) || decision.quoteRevision !== quote.revision
    || decision.cost.amountMinor !== quote.cost.amountMinor || decision.cost.currency !== quote.cost.currency)) invalid();
  return Object.freeze({ tenantId, snapshot, providerId: provider.id, configurationRevision: positive(row.configuration_revision),
    operation: row.operation, state: Object.freeze({ revision: positive(row.state_revision), status: row.status,
      updatedAt: row.state_updated_at.toISOString() }), quote, decision });
}
