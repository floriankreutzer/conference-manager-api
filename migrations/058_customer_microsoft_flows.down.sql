DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM customer_microsoft_flows LIMIT 1)
    OR EXISTS(SELECT 1 FROM customer_microsoft_start_budgets LIMIT 1)
    OR EXISTS(SELECT 1 FROM audit_events WHERE action='tenant.user.identity_linked' LIMIT 1)
  THEN RAISE EXCEPTION 'CUSTOMER_MICROSOFT_FLOWS_REQUIRE_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TRIGGER customer_microsoft_identity_link_required ON user_identity_bindings;
DROP TABLE customer_microsoft_start_budgets;
DROP TABLE customer_microsoft_flows;
DROP FUNCTION verify_customer_microsoft_link();
DROP FUNCTION guard_customer_microsoft_identity_link();
DROP FUNCTION guard_customer_microsoft_start_budget();
DROP FUNCTION guard_customer_microsoft_flow();
DROP FUNCTION customer_microsoft_snapshot_valid(jsonb);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (action IN (
  'session.issued','session.revoked','session.rotated',
  'authentication.failed','authorization.denied','request.started',
  'request.abandoned','request.created','request.transition',
  'request.transition_failed','request.booking_change','tenant.configuration.changed',
  'tenant.user_permissions.changed','tenant.entitlement.changed','tenant.lifecycle.changed',
  'tenant.onboarding.invited','tenant.identity.claimed','tenant.identity.unbound',
  'tenant.user.provisioned','tenant.user.profile_updated','integration.connected',
  'integration.disconnected','integration.admin_consent.changed','integration.verified',
  'calendar.operation','catering.catalogue.received','catering.catalogue.published','catering.catalogue.rejected','catering.order.prepared',
  'catering.order.quoted','catering.order.decided','catering.delivery.queued',
  'catering.delivery.claimed','catering.delivery.attempted','catering.delivery.observed',
  'catering.delivery.deferred','catering.delivery.recovered','catering.order.version_proposed',
  'catering.order.withdrawn','catering.order.unsent_replaced','catering.manual.transmitted',
  'catering.manual.receipt','audit.read'
));
