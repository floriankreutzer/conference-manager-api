DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_entitlements LIMIT 1) THEN
    RAISE EXCEPTION 'ENTITLEMENT_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM audit_events
    WHERE action = 'tenant.entitlement.changed'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'ENTITLEMENT_AUDIT_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

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
    'integration.connected',
    'integration.disconnected',
    'integration.admin_consent.changed',
    'calendar.operation',
    'audit.read'
  )
);

DROP TABLE tenant_entitlements;
