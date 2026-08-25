ALTER TABLE integrations
  ADD COLUMN connection_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN last_verified_at timestamptz,
  ADD COLUMN connection_reason varchar(64),
  ADD COLUMN places_permission_status varchar(16),
  ADD COLUMN calendars_permission_status varchar(16),
  ADD CONSTRAINT integrations_microsoft365_reference_valid CHECK (
    provider <> 'microsoft365'
    OR provider_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  ADD CONSTRAINT integrations_microsoft365_version_valid CHECK (
    provider <> 'microsoft365' OR connection_version > 0
  ),
  ADD CONSTRAINT integrations_microsoft365_status_valid CHECK (
    provider <> 'microsoft365'
    OR status IN ('pending', 'connected', 'degraded', 'revoked', 'disconnected')
  ),
  ADD CONSTRAINT integrations_microsoft365_permission_status_valid CHECK (
    provider <> 'microsoft365'
    OR (
      places_permission_status IN ('granted', 'missing', 'unknown')
      AND calendars_permission_status IN ('granted', 'missing', 'unknown', 'unverified')
    )
  ),
  ADD CONSTRAINT integrations_microsoft365_reason_valid CHECK (
    provider <> 'microsoft365'
    OR connection_reason IS NULL
    OR connection_reason ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  ADD CONSTRAINT integrations_microsoft365_verified_state_valid CHECK (
    provider <> 'microsoft365'
    OR (
      status IN ('pending', 'disconnected')
      AND last_verified_at IS NULL
    )
    OR (
      status IN ('connected', 'degraded', 'revoked')
      AND last_verified_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT integrations_microsoft365_verified_order CHECK (
    last_verified_at IS NULL
    OR (last_verified_at >= created_at AND last_verified_at <= updated_at)
  );

CREATE UNIQUE INDEX integrations_microsoft365_tenant_unique
  ON integrations (tenant_id)
  WHERE provider = 'microsoft365';

CREATE TABLE microsoft365_consent_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  provider_tenant_reference varchar(128) NOT NULL,
  connection_version bigint NOT NULL,
  state_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT microsoft365_consent_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT microsoft365_consent_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT microsoft365_consent_integration_fk
    FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT microsoft365_consent_provider_tenant_valid
    CHECK (provider_tenant_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT microsoft365_consent_state_hash_valid CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT microsoft365_consent_version_valid CHECK (connection_version > 0),
  CONSTRAINT microsoft365_consent_expiry_valid CHECK (expires_at > created_at)
);

CREATE INDEX microsoft365_consent_tenant_expiry_idx
  ON microsoft365_consent_transactions (tenant_id, expires_at);
