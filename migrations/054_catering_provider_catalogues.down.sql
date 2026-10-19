LOCK TABLE catering_provider_catalogue_heads,catering_provider_catalogue_revisions,audit_events IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM catering_provider_catalogue_revisions) OR EXISTS (SELECT 1 FROM catering_provider_catalogue_heads)
    OR EXISTS (SELECT 1 FROM audit_events WHERE action IN ('catering.catalogue.received','catering.catalogue.published')) THEN
    RAISE EXCEPTION 'CATERING_PROVIDER_CATALOGUE_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;
DROP TABLE catering_provider_catalogue_heads;
DROP TABLE catering_provider_catalogue_revisions;
DROP FUNCTION verify_catering_provider_catalogue_source();
DROP FUNCTION guard_catering_provider_catalogue_head();
DROP FUNCTION guard_catering_provider_catalogue_source();
DROP FUNCTION catering_provider_catalogue_document_valid(jsonb);
DROP FUNCTION catering_provider_catalogue_product_valid(jsonb);
DROP FUNCTION catering_provider_catalogue_money_valid(jsonb,boolean);
DROP FUNCTION catering_provider_catalogue_text_valid(jsonb,integer,boolean);

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
  'calendar.operation','catering.order.prepared','catering.order.quoted',
  'catering.order.decided','catering.delivery.queued','catering.delivery.claimed',
  'catering.delivery.attempted','catering.delivery.observed','catering.delivery.deferred',
  'catering.delivery.recovered','catering.order.version_proposed','catering.order.withdrawn',
  'catering.order.unsent_replaced','catering.manual.transmitted','catering.manual.receipt',
  'audit.read'
));
