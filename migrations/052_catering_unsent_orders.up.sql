-- Local withdrawal sends/cancels nothing and never removes supplier evidence.
LOCK TABLE catering_order_version_states,catering_order_heads,catering_delivery_jobs IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE catering_order_version_states DROP CONSTRAINT catering_order_version_states_status_check;
ALTER TABLE catering_order_version_states ADD CONSTRAINT catering_order_version_states_status_check CHECK (
  status IN ('pending_quote','pending_manager_review','released','queued','dispatching','reconciliation_required',
    'transmitted','confirmed','partially_confirmed','rejected','cancelled','failed','withdrawn')
);
CREATE TABLE catering_order_withdrawals (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_version bigint NOT NULL,
  command_id uuid NOT NULL,
  origin_state_revision bigint NOT NULL CHECK (origin_state_revision BETWEEN 1 AND 9007199254740989),
  previous_status varchar(32) NOT NULL CHECK (previous_status IN ('pending_quote','pending_manager_review','released','rejected','queued')),
  prior_quote_revision bigint,
  prior_decision_sequence bigint,
  job_id uuid,
  job_revision bigint CHECK (job_revision BETWEEN 1 AND 9007199254740989),
  justification varchar(1000) NOT NULL CHECK (justification=btrim(justification) AND length(justification)>0
    AND justification !~ '[[:cntrl:]]'),
  attest_not_transmitted boolean NOT NULL CHECK (attest_not_transmitted=true),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by_user_id uuid NOT NULL,
  actor_security_version bigint NOT NULL CHECK (actor_security_version BETWEEN 1 AND 9007199254740990),
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,order_id,order_version),
  UNIQUE (tenant_id,command_id),
  FOREIGN KEY (tenant_id,order_id,order_version)
    REFERENCES catering_order_version_seals(tenant_id,order_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version,prior_quote_revision)
    REFERENCES catering_order_quotes(tenant_id,order_id,version,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version,prior_decision_sequence,prior_quote_revision)
    REFERENCES catering_order_decisions(tenant_id,order_id,version,sequence,quote_revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id) REFERENCES catering_delivery_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,recorded_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((job_id IS NULL)=(job_revision IS NULL)),
  CHECK (prior_decision_sequence IS NULL OR prior_quote_revision IS NOT NULL)
);

CREATE FUNCTION guard_catering_order_withdrawal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  head public.catering_order_heads%ROWTYPE;
  state public.catering_order_version_states%ROWTYPE;
  job public.catering_delivery_jobs%ROWTYPE;
  decision public.catering_order_decisions%ROWTYPE;
  has_job boolean;
BEGIN
  PERFORM 1 FROM public.tenants WHERE id=NEW.tenant_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_WITHDRAWAL_TENANT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT head FROM public.catering_order_heads
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id FOR UPDATE;
  SELECT * INTO STRICT state FROM public.catering_order_version_states
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version FOR UPDATE;
  SELECT * INTO job FROM public.catering_delivery_jobs
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND order_version=NEW.order_version FOR UPDATE;
  has_job:=FOUND;
  IF state.decision_sequence IS NOT NULL THEN
    SELECT * INTO STRICT decision FROM public.catering_order_decisions
      WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version AND sequence=state.decision_sequence;
  END IF;
  NEW.recorded_at:=clock_timestamp();
  IF NEW.attest_not_transmitted IS DISTINCT FROM true OR head.current_version<>NEW.order_version
    OR state.revision<>NEW.origin_state_revision
    OR state.status<>NEW.previous_status
    OR (NEW.prior_quote_revision,NEW.prior_decision_sequence) IS DISTINCT FROM (state.quote_revision,state.decision_sequence)
    OR NOT EXISTS (SELECT 1 FROM public.users WHERE tenant_id=NEW.tenant_id AND id=NEW.recorded_by_user_id
      AND active=true AND security_version=NEW.actor_security_version)
    OR EXISTS (SELECT 1 FROM public.catering_manual_delivery_facts
      WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND order_version=NEW.order_version)
    OR NOT coalesce((state.status IN ('pending_quote','pending_manager_review','released') AND NOT has_job)
      OR (state.status='rejected' AND decision.decision='rejected' AND NOT has_job)
      OR (state.status='queued' AND decision.decision='approved' AND has_job),false) THEN
    RAISE EXCEPTION 'CATERING_WITHDRAWAL_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  IF has_job THEN
    IF (NEW.job_id,NEW.job_revision) IS DISTINCT FROM (job.id,job.revision)
      OR job.status NOT IN ('queued','deferred') OR job.dispatch_attempts<>0 OR job.last_observation IS NOT NULL
      OR job.lease_id IS NOT NULL OR job.lease_expires_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.catering_delivery_attempts WHERE tenant_id=NEW.tenant_id AND job_id=job.id)
      OR EXISTS (SELECT 1 FROM public.catering_delivery_observations WHERE tenant_id=NEW.tenant_id AND job_id=job.id) THEN
      RAISE EXCEPTION 'CATERING_WITHDRAWAL_DELIVERY_STARTED' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.job_id IS NOT NULL OR NEW.job_revision IS NOT NULL THEN
    RAISE EXCEPTION 'CATERING_WITHDRAWAL_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_order_withdrawal_guard BEFORE INSERT ON catering_order_withdrawals
  FOR EACH ROW EXECUTE FUNCTION guard_catering_order_withdrawal();
CREATE TRIGGER catering_order_withdrawal_immutable BEFORE UPDATE OR DELETE ON catering_order_withdrawals
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION verify_catering_order_withdrawal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catering_order_version_states state
    JOIN public.catering_order_heads head ON head.tenant_id=state.tenant_id AND head.order_id=state.order_id
      AND head.current_version=state.version
    WHERE state.tenant_id=NEW.tenant_id AND state.order_id=NEW.order_id AND state.version=NEW.order_version
      AND state.status='withdrawn' AND state.revision=NEW.origin_state_revision+1
      AND (state.quote_revision,state.decision_sequence) IS NOT DISTINCT FROM (NEW.prior_quote_revision,NEW.prior_decision_sequence))
    OR (NEW.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.catering_delivery_jobs job
      WHERE job.tenant_id=NEW.tenant_id AND job.id=NEW.job_id AND job.order_id=NEW.order_id AND job.order_version=NEW.order_version
        AND job.revision=NEW.job_revision+1 AND job.status='superseded' AND job.dispatch_attempts=0
        AND job.last_observation IS NULL AND job.lease_id IS NULL AND job.available_at IS NULL)) THEN
    RAISE EXCEPTION 'CATERING_WITHDRAWAL_EFFECT_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_order_withdrawal_effect AFTER INSERT ON catering_order_withdrawals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_order_withdrawal();

CREATE FUNCTION guard_catering_order_withdrawn_state()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.status='withdrawn' THEN
    RAISE EXCEPTION 'CATERING_WITHDRAWN_VERSION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_order_withdrawn_state_immutable BEFORE UPDATE ON catering_order_version_states
  FOR EACH ROW EXECUTE FUNCTION guard_catering_order_withdrawn_state();

CREATE FUNCTION verify_catering_order_withdrawn_state()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status='withdrawn' AND NOT EXISTS (SELECT 1 FROM public.catering_order_withdrawals evidence
    WHERE evidence.tenant_id=NEW.tenant_id AND evidence.order_id=NEW.order_id AND evidence.order_version=NEW.version
      AND evidence.origin_state_revision+1=NEW.revision
      AND (evidence.prior_quote_revision,evidence.prior_decision_sequence)
        IS NOT DISTINCT FROM (NEW.quote_revision,NEW.decision_sequence)) THEN
    RAISE EXCEPTION 'CATERING_WITHDRAWAL_EVIDENCE_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_order_withdrawn_state_evidence AFTER INSERT OR UPDATE ON catering_order_version_states
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_order_withdrawn_state();
REVOKE ALL ON TABLE catering_order_withdrawals FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_catering_order_withdrawal(),verify_catering_order_withdrawal(),
  guard_catering_order_withdrawn_state(),verify_catering_order_withdrawn_state() FROM PUBLIC;

-- Review intent stays change; only this independently proven immutable evidence
-- may route the first physical supplier operation to initial placement.
CREATE TABLE catering_unsent_replacements (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_version bigint NOT NULL,
  prior_order_version bigint NOT NULL,
  prior_state_revision bigint NOT NULL CHECK (prior_state_revision BETWEEN 1 AND 9007199254740990),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,order_id,order_version),
  CHECK (order_version=prior_order_version+1),
  FOREIGN KEY (tenant_id,order_id,order_version)
    REFERENCES catering_order_versions(tenant_id,order_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,prior_order_version)
    REFERENCES catering_order_withdrawals(tenant_id,order_id,order_version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version)
    REFERENCES catering_version_proposals(tenant_id,order_id,order_version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION guard_catering_unsent_replacement()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  head public.catering_order_heads%ROWTYPE;
  prior public.catering_order_version_states%ROWTYPE;
  proposed public.catering_order_versions%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.tenants WHERE id=NEW.tenant_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_UNSENT_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT head FROM public.catering_order_heads
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id FOR UPDATE;
  SELECT * INTO STRICT prior FROM public.catering_order_version_states
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.prior_order_version FOR UPDATE;
  SELECT * INTO STRICT proposed FROM public.catering_order_versions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version;
  NEW.recorded_at:=clock_timestamp();
  IF head.current_version<>NEW.prior_order_version OR prior.status<>'withdrawn' OR prior.revision<>NEW.prior_state_revision
    OR proposed.operation<>'change' OR proposed.version<>NEW.prior_order_version+1
    OR NOT EXISTS (SELECT 1 FROM public.catering_order_withdrawals withdrawal
      WHERE withdrawal.tenant_id=NEW.tenant_id AND withdrawal.order_id=NEW.order_id
        AND withdrawal.order_version=NEW.prior_order_version AND withdrawal.origin_state_revision+1=prior.revision)
    OR EXISTS (SELECT 1 FROM public.catering_manual_delivery_facts WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id)
    OR EXISTS (SELECT 1 FROM public.catering_delivery_jobs job WHERE job.tenant_id=NEW.tenant_id AND job.order_id=NEW.order_id
      AND (job.status<>'superseded' OR job.dispatch_attempts<>0 OR job.last_observation IS NOT NULL OR job.lease_id IS NOT NULL
        OR job.lease_expires_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.catering_delivery_attempts
          WHERE tenant_id=job.tenant_id AND job_id=job.id)
        OR EXISTS (SELECT 1 FROM public.catering_delivery_observations WHERE tenant_id=job.tenant_id AND job_id=job.id)))
    OR NOT EXISTS (SELECT 1 FROM public.requests request
      JOIN public.catering_catalogue_assignment_heads assignment ON assignment.tenant_id=request.tenant_id
      JOIN public.catering_integration_configurations configuration ON configuration.tenant_id=request.tenant_id
        AND configuration.integration_id=proposed.integration_id
      JOIN public.integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
      WHERE request.tenant_id=NEW.tenant_id AND request.id=proposed.request_id AND request.status='Confirmed'
        AND request.request_version=proposed.request_version AND assignment.revision=proposed.assignment_revision
        AND configuration.revision=proposed.configuration_revision AND configuration.order_mode IN ('api','manual')
        AND integration.status IN ('configured','active')) THEN
    RAISE EXCEPTION 'CATERING_UNSENT_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_unsent_replacement_guard BEFORE INSERT ON catering_unsent_replacements
  FOR EACH ROW EXECUTE FUNCTION guard_catering_unsent_replacement();
CREATE TRIGGER catering_unsent_replacement_immutable BEFORE UPDATE OR DELETE ON catering_unsent_replacements
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION verify_catering_unsent_replacement()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catering_version_proposals proposal
    WHERE proposal.tenant_id=NEW.tenant_id AND proposal.order_id=NEW.order_id AND proposal.order_version=NEW.order_version
      AND proposal.prior_order_version=NEW.prior_order_version AND proposal.prior_state_revision=NEW.prior_state_revision
      AND proposal.basis_order_version=NEW.prior_order_version AND proposal.operation='change'
      AND proposal.request_evidence_status='Confirmed' AND proposal.source_request_version=proposal.request_evidence_version) THEN
    RAISE EXCEPTION 'CATERING_UNSENT_REVIEW_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_unsent_replacement_review AFTER INSERT ON catering_unsent_replacements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_unsent_replacement();

CREATE FUNCTION catering_order_delivery_operation(candidate_tenant uuid,candidate_order uuid,candidate_version bigint)
RETURNS varchar(16) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN replacement.order_version IS NULL THEN history.operation ELSE 'initial' END
  FROM public.catering_order_versions history LEFT JOIN public.catering_unsent_replacements replacement
    ON replacement.tenant_id=history.tenant_id AND replacement.order_id=history.order_id AND replacement.order_version=history.version
  WHERE history.tenant_id=candidate_tenant AND history.order_id=candidate_order AND history.version=candidate_version
$$;
REVOKE ALL ON TABLE catering_unsent_replacements FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_catering_unsent_replacement(),verify_catering_unsent_replacement(),
  catering_order_delivery_operation(uuid,uuid,bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION verify_catering_order_review_heads()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  state public.catering_order_version_states%ROWTYPE;
  latest_quote bigint;
  latest_decision bigint;
  quote public.catering_order_quotes%ROWTYPE;
  decision public.catering_order_decisions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT state FROM public.catering_order_version_states
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.version;
  SELECT max(revision) INTO latest_quote FROM public.catering_order_quotes
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.version;
  SELECT max(sequence) INTO latest_decision FROM public.catering_order_decisions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.version AND quote_revision=latest_quote;
  IF state.quote_revision IS DISTINCT FROM latest_quote OR state.decision_sequence IS DISTINCT FROM latest_decision
    OR (latest_quote IS NULL AND state.status NOT IN ('pending_quote','withdrawn'))
    OR (latest_quote IS NOT NULL AND state.status='pending_quote') THEN
    RAISE EXCEPTION 'CATERING_ORDER_REVIEW_HEAD_INVALID' USING ERRCODE='23514';
  END IF;
  IF state.status IN ('released','queued','dispatching','transmitted','confirmed','partially_confirmed','cancelled') THEN
    SELECT * INTO quote FROM public.catering_order_quotes WHERE tenant_id=state.tenant_id AND order_id=state.order_id
      AND version=state.version AND revision=state.quote_revision;
    SELECT * INTO decision FROM public.catering_order_decisions WHERE tenant_id=state.tenant_id AND order_id=state.order_id
      AND version=state.version AND sequence=state.decision_sequence;
    -- Supplier cost is initially unknown: this increment requires explicit
    -- Manager acceptance of the exact quote even for automatic initial mode.
    IF decision.decision IS DISTINCT FROM 'approved' OR decision.quote_revision IS DISTINCT FROM state.quote_revision THEN
      RAISE EXCEPTION 'CATERING_ORDER_CURRENT_APPROVAL_REQUIRED' USING ERRCODE='23514';
    END IF;
    IF state.status IN ('released','queued','dispatching') AND (quote.expires_at<=clock_timestamp() OR NOT EXISTS (
      SELECT 1 FROM public.users WHERE tenant_id=state.tenant_id AND id=decision.decider_user_id
        AND active=true AND security_version=decision.decider_security_version
    )) THEN RAISE EXCEPTION 'CATERING_ORDER_APPROVAL_EXPIRED_OR_REVOKED' USING ERRCODE='23514'; END IF;
    IF state.status IN ('released','queued','dispatching') AND EXISTS (
      SELECT 1 FROM public.catering_order_versions history JOIN public.request_revisions source_revision
        ON source_revision.tenant_id=history.tenant_id AND source_revision.request_id=history.request_id
          AND source_revision.request_version=history.request_version
      WHERE history.tenant_id=state.tenant_id AND history.order_id=state.order_id AND history.version=state.version
        AND history.operation<>'cancel' AND (source_revision.record->>'startsAt')::timestamptz<=clock_timestamp()
    ) THEN RAISE EXCEPTION 'CATERING_ORDER_SCHEDULE_PASSED' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_catering_delivery_job()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE allowed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.status<>'queued' OR NEW.dispatch_attempts<>0 OR NEW.reconciliation_attempts<>0
      OR NEW.last_observation IS NOT NULL OR NEW.lease_id IS NOT NULL THEN
      RAISE EXCEPTION 'CATERING_DELIVERY_INITIAL_STATE_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.id,NEW.integration_id,NEW.provider_id,NEW.order_id,NEW.order_version,NEW.operation,
    NEW.quote_revision,NEW.decision_sequence,NEW.origin_state_revision,NEW.created_at,NEW.created_by_user_id,NEW.correlation_id)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.integration_id,OLD.provider_id,OLD.order_id,OLD.order_version,OLD.operation,
      OLD.quote_revision,OLD.decision_sequence,OLD.origin_state_revision,OLD.created_at,OLD.created_by_user_id,OLD.correlation_id)
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'CATERING_DELIVERY_JOB_REVISION_INVALID' USING ERRCODE='23514';
  END IF;
  IF OLD.status='deferred' AND NEW.status='superseded' AND NOT EXISTS (
    SELECT 1 FROM public.catering_order_withdrawals evidence WHERE evidence.tenant_id=NEW.tenant_id
      AND evidence.job_id=NEW.id AND evidence.job_revision=OLD.revision AND OLD.dispatch_attempts=0
  ) THEN RAISE EXCEPTION 'CATERING_WITHDRAWAL_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  allowed:=CASE OLD.status
    WHEN 'queued' THEN NEW.status IN ('leased','deferred','superseded')
    WHEN 'retry_wait' THEN NEW.status IN ('leased','deferred','superseded')
    WHEN 'leased' THEN NEW.status IN ('dispatching','queued','deferred','superseded')
    WHEN 'dispatching' THEN NEW.status IN ('succeeded','retry_wait','failed','reconciliation_required')
    WHEN 'reconciliation_required' THEN NEW.status IN ('reconciling','reconciliation_required')
    WHEN 'reconciling' THEN NEW.status IN ('succeeded','retry_wait','failed','reconciliation_required')
    WHEN 'deferred' THEN NEW.status IN ('queued','superseded')
    ELSE false END;
  IF NOT allowed OR NEW.dispatch_attempts<>OLD.dispatch_attempts
      +(CASE WHEN OLD.status='leased' AND NEW.status='dispatching' THEN 1 ELSE 0 END)
    OR NEW.reconciliation_attempts<>OLD.reconciliation_attempts
      +(CASE WHEN OLD.status='reconciliation_required' AND NEW.status='reconciling' AND NOT NEW.lease_manual THEN 1 ELSE 0 END)
    OR (NEW.last_observation IS DISTINCT FROM OLD.last_observation
      AND NEW.last_observation IS DISTINCT FROM coalesce(OLD.last_observation,0)+1)
    OR (NEW.status='dispatching' AND NEW.lease_id IS DISTINCT FROM OLD.lease_id) THEN
    RAISE EXCEPTION 'CATERING_DELIVERY_JOB_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'catering.order.withdrawn', 'catering.order.unsent_replaced', 'catering.order.version_proposed',
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

CREATE OR REPLACE FUNCTION guard_catering_version_proposal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  head public.catering_order_heads%ROWTYPE;
  prior public.catering_order_version_states%ROWTYPE;
  basis public.catering_order_versions%ROWTYPE;
  proposed public.catering_order_versions%ROWTYPE;
  request public.requests%ROWTYPE;
  evidence jsonb;
  effective_version bigint;
  unsent_replacement boolean;
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
  unsent_replacement:=EXISTS (SELECT 1 FROM public.catering_unsent_replacements replacement
    WHERE replacement.tenant_id=NEW.tenant_id AND replacement.order_id=NEW.order_id AND replacement.order_version=NEW.order_version
      AND replacement.prior_order_version=NEW.prior_order_version AND replacement.prior_state_revision=NEW.prior_state_revision);
  IF head.current_version<>NEW.prior_order_version OR prior.revision<>NEW.prior_state_revision
    OR prior.status NOT IN ('confirmed','rejected','failed','withdrawn') OR basis.operation='cancel'
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
        AND (CASE public.catering_order_delivery_operation(NEW.tenant_id,NEW.order_id,NEW.order_version) WHEN 'initial' THEN configuration.order_mode
          WHEN 'cancel' THEN configuration.cancel_mode ELSE configuration.update_mode END) IN ('api','manual')) THEN
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
  IF unsent_replacement THEN
    IF effective_version IS NOT NULL OR NEW.operation<>'change' OR prior.status<>'withdrawn'
      OR NEW.basis_order_version<>NEW.prior_order_version THEN
      RAISE EXCEPTION 'CATERING_VERSION_CONFIRMED_BASIS_REQUIRED' USING ERRCODE='23514';
    END IF;
  ELSE
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
          AND observation.outcome='not_sent') )
      OR (prior.status='withdrawn' AND NOT EXISTS (SELECT 1 FROM public.catering_order_withdrawals withdrawal
        WHERE withdrawal.tenant_id=NEW.tenant_id AND withdrawal.order_id=NEW.order_id
          AND withdrawal.order_version=NEW.prior_order_version AND withdrawal.origin_state_revision+1=prior.revision)) THEN
      RAISE EXCEPTION 'CATERING_VERSION_CONFIRMED_BASIS_REQUIRED' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.operation='change' THEN
    IF NEW.request_evidence_status<>'Confirmed' OR NEW.source_request_version<>NEW.request_evidence_version
      OR (NOT unsent_replacement AND NEW.source_request_version<=basis.request_version)
      OR (unsent_replacement AND NEW.source_request_version<basis.request_version) OR NOT EXISTS (
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

CREATE OR REPLACE FUNCTION guard_catering_manual_delivery_fact()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  state public.catering_order_version_states%ROWTYPE;
  first_fact public.catering_manual_delivery_facts%ROWTYPE;
  latest_fact public.catering_manual_delivery_facts%ROWTYPE;
  source public.catering_order_versions%ROWTYPE;
  decision public.catering_order_decisions%ROWTYPE;
  quote public.catering_order_quotes%ROWTYPE;
  expected_count integer;
  confirmed_count integer;
  rejected_count integer;
  expected_status varchar(32);
BEGIN
  PERFORM 1 FROM public.tenants WHERE id=NEW.tenant_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_MANUAL_TENANT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT state FROM public.catering_order_version_states
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version FOR UPDATE;
  SELECT * INTO STRICT source FROM public.catering_order_versions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version;
  SELECT * INTO STRICT decision FROM public.catering_order_decisions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version
      AND sequence=NEW.decision_sequence AND quote_revision=NEW.quote_revision;
  SELECT * INTO STRICT quote FROM public.catering_order_quotes
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version AND revision=NEW.quote_revision;
  NEW.recorded_at:=clock_timestamp();
  IF NEW.occurred_at>NEW.recorded_at OR NEW.occurred_at<source.created_at THEN
    RAISE EXCEPTION 'CATERING_MANUAL_TIME_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.origin_state_revision<>state.revision OR NEW.operation<>source.operation
    OR NEW.quote_revision IS DISTINCT FROM state.quote_revision OR NEW.decision_sequence IS DISTINCT FROM state.decision_sequence
    OR decision.decision<>'approved'
    OR NOT EXISTS (SELECT 1 FROM public.users WHERE tenant_id=NEW.tenant_id AND id=NEW.recorded_by_user_id
      AND active=true AND security_version=NEW.actor_security_version)
    OR NOT EXISTS (SELECT 1 FROM public.catering_integration_configuration_revisions configuration
      WHERE configuration.tenant_id=NEW.tenant_id AND configuration.integration_id=source.integration_id
        AND configuration.revision=source.configuration_revision AND
          (CASE public.catering_order_delivery_operation(NEW.tenant_id,NEW.order_id,NEW.order_version)
            WHEN 'initial' THEN configuration.order_mode WHEN 'cancel' THEN configuration.cancel_mode
            ELSE configuration.update_mode END)='manual')
    OR NOT EXISTS (SELECT 1 FROM public.catering_delivery_jobs job
      WHERE job.tenant_id=NEW.tenant_id AND job.order_id=NEW.order_id AND job.order_version=NEW.order_version
        AND job.integration_id=source.integration_id AND job.operation=NEW.operation AND job.quote_revision=NEW.quote_revision
        AND job.decision_sequence=NEW.decision_sequence AND job.dispatch_attempts=0 AND job.status IN ('queued','deferred')) THEN
    RAISE EXCEPTION 'CATERING_MANUAL_APPROVED_SOURCE_REQUIRED' USING ERRCODE='23514';
  END IF;
  SELECT * INTO latest_fact FROM public.catering_manual_delivery_facts
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND order_version=NEW.order_version ORDER BY sequence DESC LIMIT 1;
  IF NEW.sequence<>coalesce(latest_fact.sequence,0)+1 THEN
    RAISE EXCEPTION 'CATERING_MANUAL_SEQUENCE_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='transmitted' THEN
    IF NEW.sequence<>1 OR state.status<>'queued' OR NEW.occurred_at<decision.decided_at OR NEW.occurred_at>=quote.expires_at
      OR NEW.receipt IS NOT NULL OR NEW.status<>'transmitted' OR NOT EXISTS (
        SELECT 1 FROM public.catering_delivery_jobs job WHERE job.tenant_id=NEW.tenant_id AND job.order_id=NEW.order_id
          AND job.order_version=NEW.order_version AND job.created_at<=NEW.occurred_at
          AND job.origin_state_revision+1=state.revision
      ) THEN RAISE EXCEPTION 'CATERING_MANUAL_TRANSMISSION_INVALID' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='receipt' THEN
    SELECT * INTO STRICT first_fact FROM public.catering_manual_delivery_facts
      WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND order_version=NEW.order_version AND sequence=1;
    IF first_fact.kind<>'transmitted' OR NEW.sequence<2 OR NEW.occurred_at<latest_fact.occurred_at
      OR (NEW.quote_revision,NEW.decision_sequence) IS DISTINCT FROM (first_fact.quote_revision,first_fact.decision_sequence)
      OR state.status NOT IN ('transmitted','partially_confirmed','rejected','confirmed','cancelled')
      OR jsonb_typeof(NEW.receipt) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.receipt))<>3
      OR NOT (NEW.receipt ?& ARRAY['orderId','orderVersion','positions'])
      OR NEW.receipt->>'orderId' IS DISTINCT FROM NEW.order_id::text
      OR NEW.receipt->'orderVersion' IS DISTINCT FROM to_jsonb(NEW.order_version)
      OR jsonb_typeof(NEW.receipt->'positions') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'CATERING_MANUAL_RECEIPT_INVALID' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO expected_count FROM public.catering_order_positions
      WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version;
    IF expected_count NOT BETWEEN 1 AND 101 OR jsonb_array_length(NEW.receipt->'positions')<>expected_count
      OR (SELECT count(DISTINCT position->>'positionId') FROM jsonb_array_elements(NEW.receipt->'positions') position)<>expected_count
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.receipt->'positions') position
        WHERE jsonb_typeof(position) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(position))<>2
          OR NOT (position ?& ARRAY['positionId','outcome'])
          OR NOT coalesce(position->>'outcome' IN ('pending','confirmed','rejected','substitution_proposed'),false)
          OR NOT EXISTS (SELECT 1 FROM public.catering_order_positions sealed
            WHERE sealed.tenant_id=NEW.tenant_id AND sealed.order_id=NEW.order_id AND sealed.version=NEW.order_version
              AND sealed.position_id::text=position->>'positionId')) THEN
      RAISE EXCEPTION 'CATERING_MANUAL_RECEIPT_POSITIONS_INVALID' USING ERRCODE='23514';
    END IF;
    SELECT count(*) FILTER (WHERE position->>'outcome'='confirmed'),count(*) FILTER (WHERE position->>'outcome'='rejected')
      INTO confirmed_count,rejected_count FROM jsonb_array_elements(NEW.receipt->'positions') position;
    expected_status:=CASE WHEN confirmed_count=expected_count THEN
      CASE WHEN NEW.operation='cancel' THEN 'cancelled' ELSE 'confirmed' END
      WHEN confirmed_count>0 THEN 'partially_confirmed' WHEN rejected_count=expected_count THEN 'rejected' ELSE 'transmitted' END;
    IF NEW.status<>expected_status OR (state.status IN ('confirmed','cancelled') AND NEW.status<>state.status) THEN
      RAISE EXCEPTION 'CATERING_MANUAL_RECEIPT_STATE_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE RAISE EXCEPTION 'CATERING_MANUAL_KIND_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
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
      AND CASE public.catering_order_delivery_operation(candidate.tenant_id,candidate.order_id,candidate.order_version)
        WHEN 'initial' THEN configuration.order_mode WHEN 'cancel' THEN configuration.cancel_mode
        ELSE configuration.update_mode END IN ('api','manual')
  );
END $$;
