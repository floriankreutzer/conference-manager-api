CREATE TABLE booking_provider_references (
  tenant_id uuid NOT NULL,
  request_id varchar(128) NOT NULL,
  integration_id uuid NOT NULL,
  provider_reference varchar(255) NOT NULL,
  idempotency_key char(64) NOT NULL,
  state varchar(16) NOT NULL,
  created_correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, request_id, integration_id),
  UNIQUE (tenant_id, integration_id, provider_reference),
  UNIQUE (tenant_id, integration_id, idempotency_key),
  CONSTRAINT booking_provider_references_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT booking_provider_references_request_fk
    FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_provider_references_integration_fk
    FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_provider_references_provider_reference_valid CHECK (
    char_length(provider_reference) BETWEEN 1 AND 255
    AND provider_reference = btrim(provider_reference)
    AND provider_reference !~ '[[:cntrl:]]'
  ),
  CONSTRAINT booking_provider_references_idempotency_key_valid CHECK (
    idempotency_key ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT booking_provider_references_state_valid CHECK (
    state IN ('active', 'cancelled')
  ),
  CONSTRAINT booking_provider_references_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE INDEX booking_provider_references_tenant_state_idx
  ON booking_provider_references (tenant_id, state, updated_at DESC);
