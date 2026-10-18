LOCK TABLE request_workflow_starts, audit_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM request_workflow_starts LIMIT 1)
    OR EXISTS (SELECT 1 FROM audit_events WHERE action IN ('request.started', 'request.abandoned') LIMIT 1) THEN
    RAISE EXCEPTION 'REQUEST_WORKFLOW_ROLLBACK_REQUIRES_EMPTY_HISTORY' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TABLE request_workflow_starts;
DROP FUNCTION guard_request_workflow_transition();
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'session.issued', 'session.revoked', 'session.rotated', 'authentication.failed',
    'authorization.denied', 'request.created', 'request.transition',
    'request.transition_failed', 'request.booking_change',
    'tenant.configuration.changed', 'tenant.user_permissions.changed',
    'tenant.entitlement.changed', 'tenant.lifecycle.changed', 'tenant.onboarding.invited',
    'tenant.identity.claimed', 'tenant.identity.unbound', 'tenant.user.provisioned',
    'tenant.user.profile_updated', 'integration.connected', 'integration.disconnected',
    'integration.admin_consent.changed', 'integration.verified', 'calendar.operation', 'audit.read'
  )
);
