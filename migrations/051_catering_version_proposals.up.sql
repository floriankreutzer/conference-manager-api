-- A proposed version is not effective and sends/cancels nothing.
LOCK TABLE catering_order_versions IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_order_versions WHERE version>1) THEN
    RAISE EXCEPTION 'CATERING_VERSION_HISTORY_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
CREATE TABLE catering_version_proposals (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_version bigint NOT NULL CHECK (order_version BETWEEN 2 AND 9007199254740990),
  prior_order_version bigint NOT NULL,
  prior_state_revision bigint NOT NULL CHECK (prior_state_revision BETWEEN 1 AND 9007199254740990),
  basis_order_version bigint NOT NULL CHECK (basis_order_version BETWEEN 1 AND 9007199254740989),
  command_id uuid NOT NULL,
  operation varchar(16) NOT NULL CHECK (operation IN ('change','cancel','exception')),
  request_id varchar(128) NOT NULL,
  request_evidence_version bigint NOT NULL,
  request_evidence_status varchar(16) NOT NULL CHECK (request_evidence_status IN ('Confirmed','Cancelled')),
  source_request_version bigint NOT NULL,
  assignment_revision bigint NOT NULL,
  configuration_revision bigint NOT NULL,
  justification varchar(1000) NOT NULL CHECK (justification=btrim(justification) AND length(justification)>0
    AND justification !~ '[[:cntrl:]]'),
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  proposed_by_user_id uuid NOT NULL,
  proposer_security_version bigint NOT NULL CHECK (proposer_security_version BETWEEN 1 AND 9007199254740990),
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,order_id,order_version),
  UNIQUE (tenant_id,command_id),
  CHECK (order_version=prior_order_version+1 AND basis_order_version<=prior_order_version),
  FOREIGN KEY (tenant_id,order_id,order_version,operation)
    REFERENCES catering_order_versions(tenant_id,order_id,version,operation) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,basis_order_version)
    REFERENCES catering_order_version_seals(tenant_id,order_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,request_id,request_evidence_version)
    REFERENCES request_revisions(tenant_id,request_id,request_version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,proposed_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION guard_catering_version_proposal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  head public.catering_order_heads%ROWTYPE;
  prior public.catering_order_version_states%ROWTYPE;
  basis public.catering_order_versions%ROWTYPE;
  proposed public.catering_order_versions%ROWTYPE;
  request public.requests%ROWTYPE;
  evidence jsonb;
  effective_version bigint;
  effective_operation varchar(16);
BEGIN
  PERFORM 1 FROM public.tenants WHERE id=NEW.tenant_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_VERSION_TENANT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT head FROM public.catering_order_heads
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id FOR UPDATE;
  SELECT * INTO STRICT prior FROM public.catering_order_version_states
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.prior_order_version FOR UPDATE;
  SELECT * INTO STRICT basis FROM public.catering_order_versions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.basis_order_version;
  SELECT * INTO STRICT proposed FROM public.catering_order_versions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version;
  SELECT * INTO STRICT request FROM public.requests
    WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
  SELECT record INTO STRICT evidence FROM public.request_revisions
    WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id AND request_version=NEW.request_evidence_version;
  NEW.proposed_at:=clock_timestamp();
  IF head.current_version<>NEW.prior_order_version OR prior.revision<>NEW.prior_state_revision
    OR prior.status NOT IN ('confirmed','rejected','failed') OR basis.operation='cancel'
    OR request.request_version<>NEW.request_evidence_version OR request.status<>NEW.request_evidence_status
    OR evidence->>'status' IS DISTINCT FROM NEW.request_evidence_status
    OR (proposed.request_id,proposed.request_version,proposed.assignment_revision,proposed.configuration_revision,proposed.operation,
        proposed.created_by_user_id,proposed.correlation_id)
      IS DISTINCT FROM (NEW.request_id,NEW.source_request_version,NEW.assignment_revision,NEW.configuration_revision,NEW.operation,
        NEW.proposed_by_user_id,NEW.correlation_id)
    OR proposed.integration_id<>basis.integration_id OR proposed.created_at>NEW.proposed_at
    OR NOT EXISTS (SELECT 1 FROM public.users WHERE tenant_id=NEW.tenant_id AND id=NEW.proposed_by_user_id
      AND active=true AND security_version=NEW.proposer_security_version)
    OR NOT EXISTS (SELECT 1 FROM public.integrations integration
      JOIN public.catering_integration_configurations configuration ON configuration.tenant_id=integration.tenant_id
        AND configuration.integration_id=integration.id
      WHERE integration.tenant_id=NEW.tenant_id AND integration.id=proposed.integration_id
        AND integration.status IN ('configured','active') AND configuration.revision=NEW.configuration_revision
        AND (CASE NEW.operation WHEN 'cancel' THEN configuration.cancel_mode ELSE configuration.update_mode END) IN ('api','manual')) THEN
    RAISE EXCEPTION 'CATERING_VERSION_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT history.version,history.operation INTO effective_version,effective_operation
    FROM public.catering_order_versions history WHERE history.tenant_id=NEW.tenant_id AND history.order_id=NEW.order_id AND (
      EXISTS (SELECT 1 FROM public.catering_delivery_jobs job
        JOIN public.catering_delivery_observations observation ON observation.tenant_id=job.tenant_id AND observation.job_id=job.id
        WHERE job.tenant_id=history.tenant_id AND job.order_id=history.order_id AND job.order_version=history.version
          AND observation.outcome='transmitted' AND observation.receipt IS NOT NULL
          AND jsonb_array_length(observation.receipt->'positions')=history.position_count
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(observation.receipt->'positions') position
            WHERE position->>'outcome' IS DISTINCT FROM 'confirmed'))
      OR EXISTS (SELECT 1 FROM public.catering_manual_delivery_facts manual
        WHERE manual.tenant_id=history.tenant_id AND manual.order_id=history.order_id AND manual.order_version=history.version
          AND manual.kind='receipt' AND manual.status IN ('confirmed','cancelled')))
    ORDER BY history.version DESC LIMIT 1;
  IF effective_version IS DISTINCT FROM NEW.basis_order_version OR effective_operation='cancel'
    OR (prior.status='confirmed' AND NEW.basis_order_version<>NEW.prior_order_version)
    OR (prior.status='rejected' AND NOT EXISTS (
      SELECT 1 FROM public.catering_order_decisions decision
      WHERE decision.tenant_id=NEW.tenant_id AND decision.order_id=NEW.order_id AND decision.version=NEW.prior_order_version
        AND decision.sequence=prior.decision_sequence AND decision.quote_revision=prior.quote_revision AND decision.decision='rejected'
        AND NOT EXISTS (SELECT 1 FROM public.catering_delivery_jobs job WHERE job.tenant_id=NEW.tenant_id
          AND job.order_id=NEW.order_id AND job.order_version=NEW.prior_order_version)
    ) AND NOT EXISTS (
      SELECT 1 FROM public.catering_manual_delivery_facts manual
      WHERE manual.tenant_id=NEW.tenant_id AND manual.order_id=NEW.order_id AND manual.order_version=NEW.prior_order_version
        AND manual.kind='receipt' AND manual.status='rejected' AND manual.origin_state_revision+1=prior.revision
        AND manual.quote_revision=prior.quote_revision AND manual.decision_sequence=prior.decision_sequence
    ) AND NOT EXISTS (
      SELECT 1 FROM public.catering_delivery_jobs job
      JOIN public.catering_delivery_observations observation ON observation.tenant_id=job.tenant_id AND observation.job_id=job.id
        AND observation.sequence=job.last_observation
      JOIN public.catering_order_versions history ON history.tenant_id=job.tenant_id AND history.order_id=job.order_id
        AND history.version=job.order_version
      WHERE job.tenant_id=NEW.tenant_id AND job.order_id=NEW.order_id AND job.order_version=NEW.prior_order_version
        AND job.status='succeeded' AND job.quote_revision=prior.quote_revision AND job.decision_sequence=prior.decision_sequence
        AND observation.outcome='transmitted' AND observation.receipt IS NOT NULL
        AND jsonb_array_length(observation.receipt->'positions')=history.position_count
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(observation.receipt->'positions') position
          WHERE position->>'outcome' IS DISTINCT FROM 'rejected')
    ))
    OR (prior.status='failed' AND NOT EXISTS (SELECT 1 FROM public.catering_delivery_jobs job
      JOIN public.catering_delivery_observations observation ON observation.tenant_id=job.tenant_id AND observation.job_id=job.id
        AND observation.sequence=job.last_observation
      WHERE job.tenant_id=NEW.tenant_id AND job.order_id=NEW.order_id AND job.order_version=NEW.prior_order_version
        AND job.status='failed' AND job.quote_revision=prior.quote_revision AND job.decision_sequence=prior.decision_sequence
        AND observation.outcome='not_sent')) THEN
    RAISE EXCEPTION 'CATERING_VERSION_CONFIRMED_BASIS_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF NEW.operation='change' THEN
    IF NEW.request_evidence_status<>'Confirmed' OR NEW.source_request_version<>NEW.request_evidence_version
      OR NEW.source_request_version<=basis.request_version OR NOT EXISTS (
        SELECT 1 FROM public.catering_catalogue_assignment_heads WHERE tenant_id=NEW.tenant_id AND revision=NEW.assignment_revision
      ) THEN RAISE EXCEPTION 'CATERING_VERSION_CHANGE_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
  ELSE
    IF (NEW.source_request_version,NEW.assignment_revision) IS DISTINCT FROM (basis.request_version,basis.assignment_revision)
      OR (NEW.operation='exception' AND (NEW.request_evidence_status<>'Confirmed' OR NEW.request_evidence_version<>basis.request_version)) THEN
      RAISE EXCEPTION 'CATERING_VERSION_RETAINED_SOURCE_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_version_proposal_guard BEFORE INSERT ON catering_version_proposals
  FOR EACH ROW EXECUTE FUNCTION guard_catering_version_proposal();
CREATE TRIGGER catering_version_proposal_immutable BEFORE UPDATE OR DELETE ON catering_version_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION verify_catering_version_proposal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.version>1 AND NOT EXISTS (
    SELECT 1 FROM public.catering_version_proposals proposal
    JOIN public.catering_order_version_states state ON state.tenant_id=proposal.tenant_id AND state.order_id=proposal.order_id
      AND state.version=proposal.order_version
    WHERE proposal.tenant_id=NEW.tenant_id AND proposal.order_id=NEW.order_id AND proposal.order_version=NEW.version
      AND proposal.operation=NEW.operation AND proposal.source_request_version=NEW.request_version
      AND proposal.assignment_revision=NEW.assignment_revision AND proposal.configuration_revision=NEW.configuration_revision
      AND state.revision=1 AND state.status='pending_quote' AND state.quote_revision IS NULL AND state.decision_sequence IS NULL
  ) THEN RAISE EXCEPTION 'CATERING_VERSION_PROPOSAL_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_version_proposal_required AFTER INSERT ON catering_order_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_version_proposal();

CREATE FUNCTION catering_order_source_current(candidate_tenant uuid,candidate_order uuid,candidate_version bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.catering_order_versions history
    JOIN public.requests request ON request.tenant_id=history.tenant_id AND request.id=history.request_id
    LEFT JOIN public.catering_version_proposals proposal ON proposal.tenant_id=history.tenant_id AND proposal.order_id=history.order_id
      AND proposal.order_version=history.version
    WHERE history.tenant_id=candidate_tenant AND history.order_id=candidate_order AND history.version=candidate_version
      AND ((history.operation='initial' AND history.version=1 AND proposal.order_version IS NULL
        AND request.request_version=history.request_version AND request.status='Confirmed')
      OR (history.version>1 AND proposal.source_request_version=history.request_version
        AND proposal.assignment_revision=history.assignment_revision AND proposal.operation=history.operation
        AND request.request_version=proposal.request_evidence_version AND request.status=proposal.request_evidence_status
        AND (history.operation='cancel' OR request.status='Confirmed')))
  )
$$;
REVOKE ALL ON TABLE catering_version_proposals FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_catering_version_proposal(),verify_catering_version_proposal(),
  catering_order_source_current(uuid,uuid,bigint) FROM PUBLIC;

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
    JOIN public.tenants tenant ON tenant.id=state.tenant_id AND tenant.status='active'
    JOIN public.integrations integration ON integration.tenant_id=state.tenant_id AND integration.id=candidate.integration_id
      AND integration.provider=candidate.provider_id AND integration.status IN ('configured','active')
    JOIN public.catering_integration_configurations configuration ON configuration.tenant_id=integration.tenant_id
      AND configuration.integration_id=integration.id
    WHERE state.tenant_id=candidate.tenant_id AND state.order_id=candidate.order_id AND state.version=candidate.order_version
      AND state.status IN ('queued','dispatching')
      AND public.catering_order_source_current(state.tenant_id,state.order_id,state.version)
      AND history.integration_id=candidate.integration_id AND history.operation=candidate.operation
      AND decision.sequence=candidate.decision_sequence AND decision.quote_revision=candidate.quote_revision
      AND state.quote_revision=candidate.quote_revision AND decision.decision='approved' AND quote.expires_at>clock_timestamp()
      AND (candidate.operation='cancel' OR (request.status='Confirmed' AND request.starts_at>clock_timestamp()))
      AND CASE candidate.operation WHEN 'initial' THEN configuration.order_mode WHEN 'cancel' THEN configuration.cancel_mode
        ELSE configuration.update_mode END IN ('api','manual')
  );
END $$;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'catering.order.version_proposed',
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
