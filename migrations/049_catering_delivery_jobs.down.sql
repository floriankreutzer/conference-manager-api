LOCK TABLE catering_delivery_jobs,catering_delivery_attempts,catering_delivery_observations,audit_events
  IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_delivery_jobs) OR EXISTS (SELECT 1 FROM catering_delivery_attempts)
    OR EXISTS (SELECT 1 FROM catering_delivery_observations) OR EXISTS (SELECT 1 FROM audit_events
      WHERE action IN ('catering.delivery.queued','catering.delivery.claimed','catering.delivery.attempted',
        'catering.delivery.observed','catering.delivery.deferred','catering.delivery.recovered')) THEN
    RAISE EXCEPTION 'CATERING_DELIVERY_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE catering_delivery_jobs DROP CONSTRAINT catering_delivery_job_observation_fk;
DROP TABLE catering_delivery_observations;
DROP TABLE catering_delivery_attempts;
DROP FUNCTION catering_delivery_authority_current(public.catering_delivery_jobs);
DROP TABLE catering_delivery_jobs;
DROP FUNCTION guard_catering_delivery_job();
DROP FUNCTION verify_catering_delivery_origin();
DROP FUNCTION guard_catering_delivery_attempt();
DROP FUNCTION guard_catering_delivery_observation();
DROP FUNCTION verify_catering_delivery_heads();
ALTER TABLE catering_order_decisions DROP CONSTRAINT catering_delivery_decision_quote_unique;
ALTER TABLE catering_orders DROP CONSTRAINT catering_delivery_order_integration_unique;
ALTER TABLE catering_order_versions DROP CONSTRAINT catering_delivery_order_operation_unique;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
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
