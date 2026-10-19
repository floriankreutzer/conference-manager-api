import { normalizeCateringDeliveryJob } from '../../domain/catering-delivery-job.js';

// Shared read projection for foreground and process-owned durable job repositories.
export function cateringDeliveryJobFromRow(row, tenantId = row?.tenant_id, jobId = null) {
  return normalizeCateringDeliveryJob({ tenantId: row.tenant_id, jobId: row.id, integrationId: row.integration_id,
    orderId: row.order_id, orderVersion: Number(row.order_version), operation: row.operation,
    revision: Number(row.revision), status: row.status, dispatchAttempts: row.dispatch_attempts,
    automaticReconciliationAttempts: row.reconciliation_attempts, quoteRevision: Number(row.quote_revision),
    decisionSequence: Number(row.decision_sequence), originStateRevision: Number(row.origin_state_revision),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    availableAt: row.available_at?.toISOString() ?? null }, { tenantId, jobId });
}
