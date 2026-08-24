DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_identity_bindings LIMIT 1) THEN
    RAISE EXCEPTION 'JIT_USER_BINDINGS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM audit_events
    WHERE action IN ('tenant.user.provisioned', 'tenant.user.profile_updated')
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'JIT_USER_AUDIT_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END $$;

DROP TABLE user_identity_bindings;

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
