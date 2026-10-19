LOCK TABLE catering_orders,catering_order_versions,catering_order_positions,catering_order_version_seals,
  catering_order_heads,catering_order_quotes,catering_order_decisions,catering_order_version_states IN ACCESS EXCLUSIVE MODE;
LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_orders) OR EXISTS (SELECT 1 FROM catering_order_versions)
    OR EXISTS (SELECT 1 FROM catering_order_positions) OR EXISTS (SELECT 1 FROM catering_order_version_seals)
    OR EXISTS (SELECT 1 FROM catering_order_heads) OR EXISTS (SELECT 1 FROM catering_order_quotes)
    OR EXISTS (SELECT 1 FROM catering_order_decisions) OR EXISTS (SELECT 1 FROM catering_order_version_states) THEN
    RAISE EXCEPTION 'CATERING_ORDER_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM audit_events
    WHERE action IN ('catering.order.prepared','catering.order.quoted','catering.order.decided')) THEN
    RAISE EXCEPTION 'CATERING_ORDER_AUDIT_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE catering_order_versions DROP CONSTRAINT catering_order_previous_version_fk;
DROP TABLE catering_order_version_states;
DROP TABLE catering_order_decisions;
DROP TABLE catering_order_quotes;
DROP TABLE catering_order_heads;
DROP TABLE catering_order_version_seals;
DROP TABLE catering_order_positions;
DROP TABLE catering_order_versions;
DROP TABLE catering_orders;
DROP FUNCTION reject_catering_order_history_mutation();
DROP FUNCTION guard_catering_order_head();
DROP FUNCTION guard_catering_order_position();
DROP FUNCTION verify_catering_order_version();
DROP FUNCTION guard_catering_order_version_state();
DROP FUNCTION verify_catering_order_review_heads();
DROP FUNCTION verify_catering_order_presence();

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
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
