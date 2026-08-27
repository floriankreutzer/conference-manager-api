function publicReceipt(row) {
  return Object.freeze({
    sourceRevision: Number(row.source_revision),
    status: row.status,
    expiresAt: row.expires_at,
    response: row.applied_response,
  });
}

export async function lockTenantBulkTransferReceipt(client, {
  tenantId, id, actorUserId, aggregate, documentType, payloadSha256, appliedAt,
} = {}) {
  const result = await client.query({
    name: 'tenant-bulk-receipt-transaction-lock',
    text: `SELECT source_revision, status, expires_at, applied_response
      FROM tenant_bulk_transfer_receipts
      WHERE tenant_id=$1 AND id=$2 AND actor_user_id=$3
        AND aggregate=$4 AND document_type=$5 AND payload_sha256=$6
      FOR UPDATE`,
    values: [tenantId, id, actorUserId, aggregate, documentType, payloadSha256],
  });
  if (!result.rows[0]) return Object.freeze({ status: 'invalid' });
  const receipt = publicReceipt(result.rows[0]);
  if (receipt.status === 'applied') return Object.freeze({ status: 'replay', response: receipt.response });
  if (receipt.expiresAt.getTime() < appliedAt.getTime()) return Object.freeze({ status: 'expired' });
  return Object.freeze({ status: 'ready', sourceRevision: receipt.sourceRevision });
}

export async function finalizeTenantBulkTransferReceipt(client, {
  tenantId, id, actorUserId, payloadSha256, appliedAt, response,
} = {}) {
  const result = await client.query({
    name: 'tenant-bulk-receipt-transaction-finalize',
    text: `UPDATE tenant_bulk_transfer_receipts
      SET status='applied', applied_response=$5::jsonb, applied_at=$6
      WHERE tenant_id=$1 AND id=$2 AND actor_user_id=$3
        AND payload_sha256=$4 AND status='pending'`,
    values: [tenantId, id, actorUserId, payloadSha256, JSON.stringify(response), appliedAt],
  });
  if (result.rowCount !== 1) throw new Error('TENANT_BULK_RECEIPT_FINALIZE_FAILED');
}
