CREATE TABLE tenant_onboarding_invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT tenant_onboarding_invitations_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_onboarding_invitations_token_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_onboarding_invitations_expiry_order
    CHECK (expires_at > created_at),
  CONSTRAINT tenant_onboarding_invitations_consumed_order
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX tenant_onboarding_invitations_tenant_idx
  ON tenant_onboarding_invitations (tenant_id, created_at DESC);

CREATE TABLE tenant_identity_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider varchar(64) NOT NULL,
  provider_tenant_reference varchar(128) NOT NULL,
  status varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT tenant_identity_bindings_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_identity_bindings_provider_format
    CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT tenant_identity_bindings_reference_format
    CHECK (provider_tenant_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT tenant_identity_bindings_status_valid
    CHECK (status IN ('active', 'unbound')),
  CONSTRAINT tenant_identity_bindings_timestamps_valid
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX tenant_identity_bindings_active_provider_idx
  ON tenant_identity_bindings (provider, provider_tenant_reference)
  WHERE status = 'active';

CREATE UNIQUE INDEX tenant_identity_bindings_active_tenant_idx
  ON tenant_identity_bindings (tenant_id, provider)
  WHERE status = 'active';

CREATE TABLE tenant_claim_transactions (
  token_hash char(64) PRIMARY KEY,
  invitation_id uuid NOT NULL,
  provider varchar(64) NOT NULL,
  provider_tenant_reference varchar(128) NOT NULL,
  provider_user_reference varchar(128) NOT NULL,
  display_name varchar(200),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT tenant_claim_transactions_invitation_fk
    FOREIGN KEY (invitation_id) REFERENCES tenant_onboarding_invitations(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_claim_transactions_token_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_claim_transactions_provider_format
    CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT tenant_claim_transactions_tenant_reference_format
    CHECK (provider_tenant_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT tenant_claim_transactions_user_reference_format
    CHECK (provider_user_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT tenant_claim_transactions_display_name_valid
    CHECK (
      display_name IS NULL
      OR (
        char_length(display_name) BETWEEN 1 AND 200
        AND display_name = btrim(display_name)
      )
    ),
  CONSTRAINT tenant_claim_transactions_expiry_order
    CHECK (expires_at > created_at)
);

CREATE INDEX tenant_claim_transactions_expires_at_idx
  ON tenant_claim_transactions (expires_at);

ALTER TABLE oidc_auth_transactions
  ADD COLUMN onboarding_invitation_id uuid,
  ADD CONSTRAINT oidc_auth_transactions_onboarding_invitation_fk
    FOREIGN KEY (onboarding_invitation_id)
    REFERENCES tenant_onboarding_invitations(id)
    ON DELETE RESTRICT;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'session.issued',
    'session.revoked',
    'session.rotated',
    'authentication.failed',
    'authorization.denied',
    'request.transition',
    'request.transition_failed',
    'tenant.configuration.changed',
    'tenant.user_permissions.changed',
    'tenant.entitlement.changed',
    'tenant.onboarding.invited',
    'tenant.identity.claimed',
    'tenant.identity.unbound',
    'integration.connected',
    'integration.disconnected',
    'integration.admin_consent.changed',
    'calendar.operation',
    'audit.read'
  )
);
