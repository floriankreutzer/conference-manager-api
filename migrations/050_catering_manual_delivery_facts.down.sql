LOCK TABLE catering_manual_delivery_heads,catering_manual_delivery_facts,audit_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_manual_delivery_heads) OR EXISTS (SELECT 1 FROM catering_manual_delivery_facts)
    OR EXISTS (SELECT 1 FROM audit_events WHERE action IN ('catering.manual.transmitted','catering.manual.receipt')) THEN
    RAISE EXCEPTION 'CATERING_MANUAL_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
DROP TABLE catering_manual_delivery_heads;
DROP TABLE catering_manual_delivery_facts;
DROP FUNCTION guard_catering_manual_delivery_fact();
DROP FUNCTION guard_catering_manual_delivery_head();
DROP FUNCTION verify_catering_manual_delivery_head();

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'catering.delivery.queued', 'catering.delivery.claimed', 'catering.delivery.attempted',
    'catering.delivery.observed', 'catering.delivery.deferred', 'catering.delivery.recovered',
    'catering.order.prepared', 'catering.order.quoted', 'catering.order.decided',
    'session.issued', 'session.revoked', 'session.rotated', 'authentication.failed',
    'authorization.denied', 'request.started', 'request.abandoned', 'request.created',
    'request.transition', 'request.transition_failed', 'request.booking_change',
    'tenant.configuration.changed', 'tenant.user_permissions.changed',
    'tenant.entitlement.changed', 'tenant.lifecycle.changed', 'tenant.onboarding.invited',
    'tenant.identity.claimed', 'tenant.identity.unbound', 'tenant.user.provisioned',
    'tenant.user.profile_updated', 'integration.connected', 'integration.disconnected',
    'integration.admin_consent.changed', 'integration.verified', 'calendar.operation', 'audit.read'
  )
);
