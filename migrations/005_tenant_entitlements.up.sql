CREATE TABLE tenant_entitlements (
  tenant_id uuid NOT NULL,
  capability_id varchar(64) NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, capability_id),
  CONSTRAINT tenant_entitlements_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_entitlements_capability_valid CHECK (
    capability_id IN ('microsoft.directory', 'microsoft.calendar')
  )
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
    'integration.connected',
    'integration.disconnected',
    'integration.admin_consent.changed',
    'calendar.operation',
    'audit.read'
  )
);
