// Immutable complete confirmations determine the effective supplier order independently
// from the latest proposed version or transient processing state.
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_EFFECTIVE_VERSION_INVALID');
  }
  return value;
}

export async function readEffectiveCateringVersionWithClient(client, tenantId, orderId) {
  // Immutable complete confirmations, not the latest proposed head, determine
  // the effective version. No migration backfill or writable pointer is needed.
  const rows = await client.query(`SELECT history.version,history.operation FROM catering_order_versions history
    WHERE history.tenant_id=$1 AND history.order_id=$2 AND (EXISTS (
      SELECT 1 FROM catering_delivery_jobs job JOIN catering_delivery_observations observation
        ON observation.tenant_id=job.tenant_id AND observation.job_id=job.id
      WHERE job.tenant_id=history.tenant_id AND job.order_id=history.order_id AND job.order_version=history.version
        AND observation.outcome='transmitted' AND observation.receipt IS NOT NULL
        AND jsonb_array_length(observation.receipt->'positions')=history.position_count
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(observation.receipt->'positions') position
          WHERE position->>'outcome' IS DISTINCT FROM 'confirmed')) OR EXISTS (
      SELECT 1 FROM catering_manual_delivery_facts manual WHERE manual.tenant_id=history.tenant_id
        AND manual.order_id=history.order_id AND manual.order_version=history.version
        AND manual.kind='receipt' AND manual.status IN ('confirmed','cancelled')))
    ORDER BY history.version DESC LIMIT 1`, [tenantId,orderId]);
  return rows.rowCount === 0 ? null : Object.freeze({ orderVersion: version(Number(rows.rows[0].version)),
    status: rows.rows[0].operation === 'cancel' ? 'cancelled' : 'confirmed' });
}
