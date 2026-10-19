LOCK TABLE catering_catalogue_reviews,catering_catalogue_review_heads,catering_catalogue_publication_heads,audit_events IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM catering_catalogue_reviews) OR EXISTS (SELECT 1 FROM catering_catalogue_review_heads)
    OR EXISTS (SELECT 1 FROM catering_catalogue_publication_heads)
    OR EXISTS (SELECT 1 FROM audit_events WHERE action IN ('catering.catalogue.published','catering.catalogue.rejected')) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_PUBLICATION_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;
DROP TABLE catering_catalogue_publication_heads;
DROP TABLE catering_catalogue_review_heads;
DROP TABLE catering_catalogue_reviews;
DROP FUNCTION verify_catering_catalogue_review();
DROP FUNCTION guard_catering_catalogue_review_head();
DROP FUNCTION guard_catering_catalogue_review();
DROP FUNCTION catering_catalogue_review_command_valid(jsonb);
DROP FUNCTION catering_catalogue_review_mapping_valid(jsonb,boolean,boolean);

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
  'calendar.operation','catering.catalogue.received','catering.order.prepared',
  'catering.order.quoted','catering.order.decided','catering.delivery.queued',
  'catering.delivery.claimed','catering.delivery.attempted','catering.delivery.observed',
  'catering.delivery.deferred','catering.delivery.recovered','catering.order.version_proposed',
  'catering.order.withdrawn','catering.order.unsent_replaced','catering.manual.transmitted',
  'catering.manual.receipt','audit.read'
));
