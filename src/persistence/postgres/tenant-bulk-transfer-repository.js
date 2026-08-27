import { withPostgresTransaction } from './transaction.js';

function receiptRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    aggregate: row.aggregate,
    documentType: row.document_type,
    sourceRevision: Number(row.source_revision),
    payloadSha256: row.payload_sha256,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    appliedResponse: row.applied_response,
  });
}

export function createPostgresTenantBulkTransferRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  return Object.freeze({
    async create({
      tenantId,
      id,
      actorUserId,
      aggregate,
      documentType,
      sourceRevision,
      payloadSha256,
      createdAt,
      expiresAt,
      correlationId,
    }) {
      const result = await pool.query({
        name: 'tenant-bulk-receipt-create',
        text: `
          INSERT INTO tenant_bulk_transfer_receipts (
            tenant_id, id, actor_user_id, aggregate, document_type, source_revision,
            payload_sha256, status, expires_at, created_at, correlation_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
          RETURNING *
        `,
        values: [
          tenantId, id, actorUserId, aggregate, documentType, sourceRevision,
          payloadSha256, expiresAt, createdAt, correlationId,
        ],
      });
      return receiptRow(result.rows[0]);
    },

    async load({ tenantId, id }) {
      const result = await pool.query({
        name: 'tenant-bulk-receipt-load',
        text: 'SELECT * FROM tenant_bulk_transfer_receipts WHERE tenant_id=$1 AND id=$2',
        values: [tenantId, id],
      });
      return receiptRow(result.rows[0]);
    },

    async markApplied({ tenantId, id, actorUserId, payloadSha256, appliedAt, response }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'tenant-bulk-receipt-lock',
          text: `SELECT * FROM tenant_bulk_transfer_receipts
            WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          values: [tenantId, id],
        });
        const receipt = receiptRow(locked.rows[0]);
        if (!receipt) return Object.freeze({ status: 'not_found' });
        if (receipt.actorUserId !== actorUserId || receipt.payloadSha256 !== payloadSha256) {
          return Object.freeze({ status: 'forbidden' });
        }
        if (receipt.status === 'applied') {
          return Object.freeze({ status: 'replay', response: receipt.appliedResponse });
        }
        if (Date.parse(receipt.expiresAt) < appliedAt.getTime()) {
          return Object.freeze({ status: 'expired' });
        }
        const updated = await client.query({
          name: 'tenant-bulk-receipt-apply',
          text: `UPDATE tenant_bulk_transfer_receipts
            SET status='applied', applied_response=$4::jsonb, applied_at=$5
            WHERE tenant_id=$1 AND id=$2 AND actor_user_id=$3 AND status='pending'
            RETURNING *`,
          values: [tenantId, id, actorUserId, JSON.stringify(response), appliedAt],
        });
        if (updated.rowCount !== 1) return Object.freeze({ status: 'conflict' });
        return Object.freeze({ status: 'applied', response });
      });
    },
  });
}
