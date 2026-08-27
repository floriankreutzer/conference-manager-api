CREATE TABLE tenant_bulk_transfer_receipts (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  aggregate VARCHAR(32) NOT NULL,
  document_type VARCHAR(32) NOT NULL,
  source_revision BIGINT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  applied_response JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_bulk_receipt_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_bulk_receipt_aggregate_valid
    CHECK (aggregate IN ('locations', 'catalogue', 'cost_allocation')),
  CONSTRAINT tenant_bulk_receipt_type_valid
    CHECK (document_type IN ('sites', 'rooms', 'services', 'catering-items', 'catering-packages', 'cost-centers')),
  CONSTRAINT tenant_bulk_receipt_revision_valid
    CHECK (source_revision BETWEEN 1 AND 9007199254740990),
  CONSTRAINT tenant_bulk_receipt_hash_valid
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_bulk_receipt_status_valid
    CHECK (status IN ('pending', 'applied')),
  CONSTRAINT tenant_bulk_receipt_expiry_valid
    CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '30 minutes'),
  CONSTRAINT tenant_bulk_receipt_application_valid
    CHECK (
      (status = 'pending' AND applied_response IS NULL AND applied_at IS NULL)
      OR (status = 'applied' AND applied_response IS NOT NULL AND applied_at IS NOT NULL
          AND applied_at >= created_at AND octet_length(applied_response::TEXT) <= 524288)
    )
);

CREATE INDEX tenant_bulk_receipts_pending_expiry_idx
  ON tenant_bulk_transfer_receipts (expires_at, tenant_id, id)
  WHERE status = 'pending';
