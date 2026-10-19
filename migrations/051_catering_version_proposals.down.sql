LOCK TABLE catering_version_proposals,catering_order_versions,audit_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_version_proposals) OR EXISTS (SELECT 1 FROM catering_order_versions WHERE version>1)
    OR EXISTS (SELECT 1 FROM audit_events WHERE action='catering.order.version_proposed') THEN
    RAISE EXCEPTION 'CATERING_VERSION_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION catering_delivery_authority_current(candidate public.catering_delivery_jobs)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.catering_order_version_states state
    JOIN public.catering_order_heads head ON head.tenant_id=state.tenant_id AND head.order_id=state.order_id
      AND head.current_version=state.version
    JOIN public.catering_order_decisions decision ON decision.tenant_id=state.tenant_id AND decision.order_id=state.order_id
      AND decision.version=state.version AND decision.sequence=state.decision_sequence
    JOIN public.catering_order_quotes quote ON quote.tenant_id=decision.tenant_id AND quote.order_id=decision.order_id
      AND quote.version=decision.version AND quote.revision=decision.quote_revision
    JOIN public.users decider ON decider.tenant_id=decision.tenant_id AND decider.id=decision.decider_user_id
      AND decider.active=true AND decider.security_version=decision.decider_security_version
    JOIN public.catering_order_versions history ON history.tenant_id=state.tenant_id AND history.order_id=state.order_id
      AND history.version=state.version
    JOIN public.requests request ON request.tenant_id=history.tenant_id AND request.id=history.request_id
      AND request.request_version=history.request_version
    JOIN public.tenants tenant ON tenant.id=state.tenant_id AND tenant.status='active'
    JOIN public.integrations integration ON integration.tenant_id=state.tenant_id AND integration.id=candidate.integration_id
      AND integration.provider=candidate.provider_id AND integration.status IN ('configured','active')
    JOIN public.catering_integration_configurations configuration ON configuration.tenant_id=integration.tenant_id
      AND configuration.integration_id=integration.id
    WHERE state.tenant_id=candidate.tenant_id AND state.order_id=candidate.order_id AND state.version=candidate.order_version
      AND state.status IN ('queued','dispatching')
      AND history.integration_id=candidate.integration_id AND history.operation=candidate.operation
      AND decision.sequence=candidate.decision_sequence AND decision.quote_revision=candidate.quote_revision
      AND state.quote_revision=candidate.quote_revision AND decision.decision='approved' AND quote.expires_at>clock_timestamp()
      AND (candidate.operation='cancel' OR (request.status='Confirmed' AND request.starts_at>clock_timestamp()))
      AND CASE candidate.operation WHEN 'initial' THEN configuration.order_mode WHEN 'cancel' THEN configuration.cancel_mode
        ELSE configuration.update_mode END IN ('api','manual')
  );
END $$;

DROP TRIGGER catering_version_proposal_required ON catering_order_versions;
DROP TABLE catering_version_proposals;
DROP FUNCTION guard_catering_version_proposal();
DROP FUNCTION verify_catering_version_proposal();
DROP FUNCTION catering_order_source_current(uuid,uuid,bigint);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'catering.manual.transmitted', 'catering.manual.receipt',
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
