CREATE TABLE user_identity_bindings (
  tenant_id uuid NOT NULL,
  provider varchar(64) NOT NULL,
  provider_tenant_reference varchar(128) NOT NULL,
  provider_user_reference varchar(128) NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, provider, provider_tenant_reference, provider_user_reference),
  UNIQUE (tenant_id, user_id, provider),
  CONSTRAINT user_identity_bindings_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT user_identity_bindings_user_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_identity_bindings_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT user_identity_bindings_tenant_reference_valid
    CHECK (provider_tenant_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT user_identity_bindings_user_reference_valid
    CHECK (provider_user_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT user_identity_bindings_timestamps_valid
    CHECK (updated_at >= created_at)
);

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
    'tenant.user.provisioned',
    'tenant.user.profile_updated',
    'integration.connected',
    'integration.disconnected',
    'integration.admin_consent.changed',
    'calendar.operation',
    'audit.read'
  )
);
