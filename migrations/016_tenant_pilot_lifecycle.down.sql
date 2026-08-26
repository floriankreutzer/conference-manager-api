DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM audit_events
    WHERE action = 'tenant.lifecycle.changed'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'TENANT_LIFECYCLE_AUDIT_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
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
    'request.created',
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
    'integration.verified',
    'calendar.operation',
    'audit.read'
  )
);
