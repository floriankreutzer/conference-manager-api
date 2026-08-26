DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking_change_requests LIMIT 1) THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM audit_events WHERE action = 'request.booking_change' LIMIT 1
  ) THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_AUDIT_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP INDEX booking_change_request_history_idx;
DROP INDEX booking_change_one_open_per_request_idx;
DROP TABLE booking_change_requests;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'session.issued', 'session.revoked', 'session.rotated', 'authentication.failed',
    'authorization.denied', 'request.created', 'request.transition',
    'request.transition_failed', 'tenant.configuration.changed',
    'tenant.user_permissions.changed', 'tenant.entitlement.changed',
    'tenant.lifecycle.changed', 'tenant.onboarding.invited', 'tenant.identity.claimed',
    'tenant.identity.unbound', 'tenant.user.provisioned', 'tenant.user.profile_updated',
    'integration.connected', 'integration.disconnected',
    'integration.admin_consent.changed', 'integration.verified', 'calendar.operation', 'audit.read'
  )
);
