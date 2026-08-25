CREATE TABLE microsoft365_capability_health (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  capability varchar(32) NOT NULL,
  status varchar(16) NOT NULL,
  reason varchar(64),
  last_checked_at timestamptz NOT NULL,
  last_success_at timestamptz,
  PRIMARY KEY (tenant_id, integration_id, capability),
  CONSTRAINT microsoft365_capability_health_integration_fk
    FOREIGN KEY (tenant_id, integration_id)
    REFERENCES integrations(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT microsoft365_capability_health_capability_valid CHECK (
    capability IN ('places', 'free_busy', 'calendar_write')
  ),
  CONSTRAINT microsoft365_capability_health_status_valid CHECK (
    status IN ('healthy', 'degraded', 'unavailable', 'revoked', 'permission_missing', 'not_configured')
  ),
  CONSTRAINT microsoft365_capability_health_reason_valid CHECK (
    reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT microsoft365_capability_health_success_order CHECK (
    last_success_at IS NULL OR last_success_at <= last_checked_at
  )
);

CREATE INDEX microsoft365_capability_health_tenant_idx
  ON microsoft365_capability_health (tenant_id, last_checked_at DESC);
