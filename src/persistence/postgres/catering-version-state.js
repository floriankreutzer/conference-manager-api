import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeCateringVersionProposal, cateringVersionProposalBasis } from '../../domain/catering-version-proposal.js';
import { capabilityForCateringOrderOperation } from '../../domain/catering-order-state.js';
import { readCateringOrderWithClient } from './catering-order-source.js';
import { readEffectiveCateringVersionWithClient } from './catering-effective-version.js';
import { readCurrentCateringConnectionWithClient } from './catering-current-connection.js';

export function versionCounter(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_VERSION_COUNTER_INVALID');
  }
  return value;
}
export function versionUuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CATERING_VERSION_SCOPE_INVALID');
  return value.toLowerCase();
}
export const versionOrderState = (view) => Object.freeze({ orderVersion: view.snapshot.orderVersion,
  revision: view.state.revision, status: view.state.status });
export function cateringVersionProposalFromRow(row) {
  return normalizeCateringVersionProposal({ tenantId: row.tenant_id, orderId: row.order_id, orderVersion: Number(row.order_version),
    priorOrderVersion: Number(row.prior_order_version), priorStateRevision: Number(row.prior_state_revision),
    basisOrderVersion: Number(row.basis_order_version), commandId: row.command_id, operation: row.operation,
    requestId: row.request_id, requestEvidenceVersion: Number(row.request_evidence_version),
    requestEvidenceStatus: row.request_evidence_status, sourceRequestVersion: Number(row.source_request_version),
    assignmentRevision: Number(row.assignment_revision), configurationRevision: Number(row.configuration_revision),
    justification: row.justification, proposedAt: row.proposed_at.toISOString(), proposedByUserId: row.proposed_by_user_id,
    proposerSecurityVersion: Number(row.proposer_security_version) }, { tenantId: row.tenant_id, orderId: row.order_id });
}

export async function readCateringVersionContextWithClient(client, { tenantId, orderId, registry, lock = false }) {
  if (lock) await client.query('SELECT current_version FROM catering_order_heads WHERE tenant_id=$1 AND order_id=$2 FOR UPDATE',
    [tenantId,orderId]);
  const view = await readCateringOrderWithClient(client, { tenantId, orderId, registry, lock });
  if (!view) return null;
  const effective = await readEffectiveCateringVersionWithClient(client, tenantId, orderId);
  const basis = effective === null ? null : await readCateringOrderWithClient(client,
    { tenantId, orderId, version: effective.orderVersion, registry });
  if (basis && (!basis.quote || basis.state.status !== effective.status)) throw new TypeError('CATERING_VERSION_BASIS_INVALID');
  const requests = await client.query(`SELECT request.request_version,request.status,history.record
    FROM requests request JOIN request_revisions history ON history.tenant_id=request.tenant_id AND history.request_id=request.id
      AND history.request_version=request.request_version
    WHERE request.tenant_id=$1 AND request.id=$2 ${lock ? 'FOR UPDATE OF request' : ''}`, [tenantId,view.snapshot.requestId]);
  const row = requests.rows[0];
  const request = !row || !['Confirmed','Cancelled'].includes(row.status) ? null : Object.freeze({
    version: versionCounter(Number(row.request_version)), status: row.status,
    catalogueRevision: versionCounter(Number(row.record.configurationRevisions?.catalogue)),
  });
  const assignments = await client.query(`SELECT head.revision,history.catalogue_revision FROM catering_catalogue_assignment_heads head
    JOIN catering_catalogue_assignment_revisions history ON history.tenant_id=head.tenant_id AND history.revision=head.revision
    WHERE head.tenant_id=$1 ${lock ? 'FOR SHARE OF head' : ''}`, [tenantId]);
  const assignmentRevision = assignments.rowCount === 0 ? 0 : versionCounter(Number(assignments.rows[0].revision));
  const configured = lock ? await readCurrentCateringConnectionWithClient(client, tenantId, view.snapshot.integrationId, registry) : null;
  // Read-only discovery must not take the configuration writer's row lock.
  let modes = configured?.capabilities;
  if (!lock) {
    const configuration = await client.query(`SELECT configuration.order_mode,configuration.update_mode,configuration.cancel_mode
      FROM catering_integration_configurations configuration JOIN integrations integration
        ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
      WHERE configuration.tenant_id=$1 AND configuration.integration_id=$2 AND integration.status IN ('configured','active')`,
    [tenantId,view.snapshot.integrationId]);
    modes = configuration.rowCount === 0 ? null : {
      'catering.order': configuration.rows[0].order_mode,
      'catering.update': configuration.rows[0].update_mode, 'catering.cancel': configuration.rows[0].cancel_mode,
    };
  }
  const plans = {};
  if (request) for (const operation of ['change','cancel','exception']) {
    const reference = basis ?? view;
    const plan = cateringVersionProposalBasis({ operation, headVersion: view.snapshot.orderVersion, headStatus: view.state.status,
      effective, currentRequestVersion: request.version, currentRequestStatus: request.status,
      effectiveRequestVersion: reference.snapshot.requestVersion, effectiveAssignmentRevision: reference.snapshot.assignmentRevision });
    if (plan.eligible && ['manual','api'].includes(modes?.[capabilityForCateringOrderOperation(plan.deliveryOperation ?? operation)])
      && (operation !== 'change' || (assignmentRevision > 0
        && Number(assignments.rows[0].catalogue_revision) === request.catalogueRevision))) plans[operation] = plan;
  }
  return Object.freeze({ view, effective, basis, request, assignmentRevision, configured, plans: Object.freeze(plans) });
}

export async function readCateringVersionPageWithClient(client, { tenantId, orderId, afterOrderVersion }) {
  const rows = await client.query(`SELECT * FROM catering_version_proposals WHERE tenant_id=$1 AND order_id=$2
    AND order_version>$3 ORDER BY order_version LIMIT 21`, [tenantId,orderId,afterOrderVersion]);
  const proposals = Object.freeze(rows.rows.slice(0, 20).map(cateringVersionProposalFromRow));
  return Object.freeze({ proposals, nextAfterOrderVersion: rows.rowCount > 20 ? proposals.at(-1).orderVersion : null });
}
