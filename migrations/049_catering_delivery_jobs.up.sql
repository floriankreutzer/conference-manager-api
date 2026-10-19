-- Explicit enqueue only: no historical order is activated by schema installation.
ALTER TABLE catering_order_versions ADD CONSTRAINT catering_delivery_order_operation_unique
  UNIQUE (tenant_id,order_id,version,operation);
ALTER TABLE catering_orders ADD CONSTRAINT catering_delivery_order_integration_unique
  UNIQUE (tenant_id,id,integration_id);
ALTER TABLE catering_order_decisions ADD CONSTRAINT catering_delivery_decision_quote_unique
  UNIQUE (tenant_id,order_id,version,sequence,quote_revision);

CREATE TABLE catering_delivery_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  integration_id uuid NOT NULL,
  provider_id varchar(48) NOT NULL CHECK (provider_id ~ '^[a-z][a-z0-9_]{1,47}$'),
  order_id uuid NOT NULL,
  order_version bigint NOT NULL,
  operation varchar(16) NOT NULL,
  quote_revision bigint NOT NULL,
  decision_sequence bigint NOT NULL,
  origin_state_revision bigint NOT NULL CHECK (origin_state_revision BETWEEN 1 AND 9007199254740989),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  status varchar(32) NOT NULL CHECK (status IN ('queued','leased','dispatching','reconciling','retry_wait',
    'deferred','reconciliation_required','succeeded','failed','superseded')),
  dispatch_attempts integer NOT NULL CHECK (dispatch_attempts BETWEEN 0 AND 3),
  reconciliation_attempts integer NOT NULL CHECK (reconciliation_attempts BETWEEN 0 AND 10),
  last_observation bigint,
  lease_id uuid,
  lease_expires_at timestamptz,
  available_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,integration_id,order_id,order_version,operation),
  FOREIGN KEY (tenant_id,order_id,integration_id) REFERENCES catering_orders(tenant_id,id,integration_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version,operation)
    REFERENCES catering_order_versions(tenant_id,order_id,version,operation) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version,decision_sequence,quote_revision)
    REFERENCES catering_order_decisions(tenant_id,order_id,version,sequence,quote_revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((status IN ('leased','dispatching','reconciling'))=(lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL)),
  CHECK (status NOT IN ('queued','retry_wait') OR available_at IS NOT NULL),
  CHECK (status NOT IN ('dispatching','reconciling','reconciliation_required','succeeded','failed') OR dispatch_attempts>0),
  CHECK (status NOT IN ('queued','retry_wait') OR dispatch_attempts<3),
  CHECK (updated_at>=created_at)
);
CREATE TABLE catering_delivery_attempts (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  lease_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,job_id,attempt),
  FOREIGN KEY (tenant_id,job_id) REFERENCES catering_delivery_jobs(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE catering_delivery_observations (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740990),
  attempt integer NOT NULL,
  lease_id uuid NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('dispatch','reconcile','recovery')),
  outcome varchar(16) NOT NULL CHECK (outcome IN ('not_sent','rejected','unknown','transmitted')),
  retryable boolean NOT NULL DEFAULT false,
  failure_code varchar(32) NOT NULL CHECK (failure_code IN ('none','timeout','throttled','unavailable',
    'authorization','validation','response_invalid','lease_expired','unknown')),
  receipt jsonb,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,job_id,sequence),
  FOREIGN KEY (tenant_id,job_id,attempt) REFERENCES catering_delivery_attempts(tenant_id,job_id,attempt) ON DELETE RESTRICT,
  CHECK ((outcome='transmitted')=(receipt IS NOT NULL)),
  CHECK (NOT retryable OR outcome='not_sent'),
  CHECK (receipt IS NULL OR octet_length(receipt::text)<=32768),
  CHECK ((kind='recovery' AND outcome='unknown' AND failure_code='lease_expired') OR kind<>'recovery'),
  CHECK ((kind='recovery')=(failure_code='lease_expired')),
  CHECK ((outcome='transmitted' AND failure_code='none') OR (outcome<>'transmitted' AND failure_code<>'none'))
);
ALTER TABLE catering_delivery_jobs ADD CONSTRAINT catering_delivery_job_observation_fk
  FOREIGN KEY (tenant_id,id,last_observation) REFERENCES catering_delivery_observations(tenant_id,job_id,sequence)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX catering_delivery_due_lookup ON catering_delivery_jobs(available_at,tenant_id,id)
  WHERE status IN ('queued','retry_wait','reconciliation_required');
CREATE INDEX catering_delivery_expired_lease_lookup ON catering_delivery_jobs(lease_expires_at,tenant_id,id)
  WHERE status IN ('leased','dispatching','reconciling');

CREATE FUNCTION guard_catering_delivery_job()
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
  allowed:=CASE OLD.status
    WHEN 'queued' THEN NEW.status IN ('leased','deferred','superseded')
    WHEN 'retry_wait' THEN NEW.status IN ('leased','deferred','superseded')
    WHEN 'leased' THEN NEW.status IN ('dispatching','queued','deferred','superseded')
    WHEN 'dispatching' THEN NEW.status IN ('succeeded','retry_wait','failed','reconciliation_required')
    WHEN 'reconciliation_required' THEN NEW.status IN ('reconciling','reconciliation_required')
    WHEN 'reconciling' THEN NEW.status IN ('succeeded','retry_wait','failed','reconciliation_required')
    WHEN 'deferred' THEN NEW.status='queued'
    ELSE false END;
  IF NOT allowed OR NEW.dispatch_attempts<>OLD.dispatch_attempts
      +CASE WHEN OLD.status='leased' AND NEW.status='dispatching' THEN 1 ELSE 0 END
    OR NEW.reconciliation_attempts<>OLD.reconciliation_attempts
      +CASE WHEN OLD.status='reconciliation_required' AND NEW.status='reconciling' THEN 1 ELSE 0 END
    OR (NEW.last_observation IS DISTINCT FROM OLD.last_observation
      AND NEW.last_observation IS DISTINCT FROM coalesce(OLD.last_observation,0)+1)
    OR (NEW.status='dispatching' AND NEW.lease_id IS DISTINCT FROM OLD.lease_id) THEN
    RAISE EXCEPTION 'CATERING_DELIVERY_JOB_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_delivery_job_guard BEFORE INSERT OR UPDATE ON catering_delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_catering_delivery_job();
CREATE TRIGGER catering_delivery_job_delete_guard BEFORE DELETE ON catering_delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_delivery_attempt_immutable BEFORE UPDATE OR DELETE ON catering_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_delivery_observation_immutable BEFORE UPDATE OR DELETE ON catering_delivery_observations
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION catering_delivery_authority_current(candidate public.catering_delivery_jobs)
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
CREATE FUNCTION verify_catering_delivery_origin()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT public.catering_delivery_authority_current(NEW) OR NOT EXISTS (
    SELECT 1 FROM public.catering_order_version_states WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id
      AND version=NEW.order_version AND revision=NEW.origin_state_revision+1 AND status='queued'
  ) THEN RAISE EXCEPTION 'CATERING_DELIVERY_CURRENT_APPROVAL_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_delivery_origin AFTER INSERT ON catering_delivery_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_delivery_origin();

CREATE FUNCTION guard_catering_delivery_attempt()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE job public.catering_delivery_jobs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM public.catering_delivery_jobs WHERE tenant_id=NEW.tenant_id AND id=NEW.job_id FOR UPDATE;
  IF NOT public.catering_delivery_authority_current(job) OR job.status<>'leased'
    OR job.lease_id IS DISTINCT FROM NEW.lease_id OR job.lease_expires_at<=clock_timestamp()
    OR NEW.attempt<>job.dispatch_attempts+1 THEN
    RAISE EXCEPTION 'CATERING_DELIVERY_ATTEMPT_LEASE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_delivery_attempt_guard BEFORE INSERT ON catering_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_catering_delivery_attempt();

CREATE FUNCTION guard_catering_delivery_observation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  job public.catering_delivery_jobs%ROWTYPE;
  position_count integer;
  receipt_positions jsonb;
BEGIN
  SELECT * INTO STRICT job FROM public.catering_delivery_jobs WHERE tenant_id=NEW.tenant_id AND id=NEW.job_id FOR UPDATE;
  IF job.lease_id IS DISTINCT FROM NEW.lease_id OR NEW.attempt<>job.dispatch_attempts
    OR NEW.sequence<>coalesce(job.last_observation,0)+1
    OR (NEW.kind='dispatch' AND (job.status<>'dispatching' OR job.lease_expires_at<=clock_timestamp()))
    OR (NEW.kind='reconcile' AND (job.status<>'reconciling' OR job.lease_expires_at<=clock_timestamp()))
    OR (NEW.kind='recovery' AND (job.status NOT IN ('dispatching','reconciling') OR job.lease_expires_at>clock_timestamp())) THEN
    RAISE EXCEPTION 'CATERING_DELIVERY_OBSERVATION_LEASE_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.receipt IS NOT NULL THEN
    IF jsonb_typeof(NEW.receipt)<>'object' OR NOT (NEW.receipt ?& ARRAY['orderId','orderVersion','positions'])
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.receipt))<>3
      OR NEW.receipt->>'orderId' IS DISTINCT FROM job.order_id::text
      OR jsonb_typeof(NEW.receipt->'orderVersion') IS DISTINCT FROM 'number'
      OR (NEW.receipt->>'orderVersion')::numeric<>job.order_version
      OR jsonb_typeof(NEW.receipt->'positions') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'CATERING_DELIVERY_RECEIPT_SCOPE_INVALID' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO position_count FROM public.catering_order_positions
      WHERE tenant_id=job.tenant_id AND order_id=job.order_id AND version=job.order_version;
    receipt_positions:=NEW.receipt->'positions';
    IF jsonb_array_length(receipt_positions)<>position_count
      OR (SELECT count(DISTINCT position->>'positionId') FROM jsonb_array_elements(receipt_positions) position)<>position_count
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(receipt_positions) position
        WHERE jsonb_typeof(position)<>'object' OR NOT (position ?& ARRAY['positionId','outcome'])
          OR (SELECT count(*) FROM jsonb_object_keys(position))<>2
          OR coalesce(position->>'outcome','') NOT IN ('pending','confirmed','rejected','substitution_proposed')
          OR NOT EXISTS (SELECT 1 FROM public.catering_order_positions expected
            WHERE expected.tenant_id=job.tenant_id AND expected.order_id=job.order_id AND expected.version=job.order_version
              AND expected.position_id::text=position->>'positionId')) THEN
      RAISE EXCEPTION 'CATERING_DELIVERY_RECEIPT_POSITIONS_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_delivery_observation_guard BEFORE INSERT ON catering_delivery_observations
  FOR EACH ROW EXECUTE FUNCTION guard_catering_delivery_observation();

CREATE FUNCTION verify_catering_delivery_heads()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  job public.catering_delivery_jobs%ROWTYPE;
  job_identifier uuid;
  latest_attempt integer;
  latest_observation bigint;
  latest_outcome text;
  observed_attempt integer;
  observed_retryable boolean;
BEGIN
  IF TG_TABLE_NAME='catering_delivery_jobs' THEN job_identifier:=NEW.id;
  ELSE job_identifier:=NEW.job_id; END IF;
  SELECT * INTO STRICT job FROM public.catering_delivery_jobs WHERE tenant_id=NEW.tenant_id AND id=job_identifier;
  SELECT coalesce(max(attempt),0) INTO latest_attempt FROM public.catering_delivery_attempts
    WHERE tenant_id=job.tenant_id AND job_id=job.id;
  SELECT max(sequence) INTO latest_observation FROM public.catering_delivery_observations
    WHERE tenant_id=job.tenant_id AND job_id=job.id;
  SELECT outcome,attempt,retryable INTO latest_outcome,observed_attempt,observed_retryable
    FROM public.catering_delivery_observations
    WHERE tenant_id=job.tenant_id AND job_id=job.id AND sequence=latest_observation;
  IF job.dispatch_attempts<>latest_attempt OR job.last_observation IS DISTINCT FROM latest_observation
    OR (job.status='succeeded' AND latest_outcome IS DISTINCT FROM 'transmitted')
    OR (job.status='failed' AND NOT coalesce(latest_outcome='rejected'
      OR (latest_outcome='not_sent' AND (NOT observed_retryable OR latest_attempt=3)),false))
    OR (job.status<>'dispatching' AND latest_attempt>0 AND observed_attempt IS DISTINCT FROM latest_attempt)
    OR (job.status IN ('queued','leased','retry_wait','deferred') AND latest_attempt>0 AND (latest_outcome IS DISTINCT FROM 'not_sent' OR observed_retryable IS DISTINCT FROM true))
    OR (job.status IN ('reconciliation_required','reconciling') AND latest_outcome IS DISTINCT FROM 'unknown')
    OR (job.status='dispatching' AND NOT EXISTS (SELECT 1 FROM public.catering_delivery_attempts intent
      WHERE intent.tenant_id=job.tenant_id AND intent.job_id=job.id AND intent.attempt=job.dispatch_attempts
        AND intent.lease_id=job.lease_id)) THEN
    RAISE EXCEPTION 'CATERING_DELIVERY_HEAD_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_delivery_job_heads AFTER INSERT OR UPDATE ON catering_delivery_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_delivery_heads();
CREATE CONSTRAINT TRIGGER catering_delivery_attempt_heads AFTER INSERT ON catering_delivery_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_delivery_heads();
CREATE CONSTRAINT TRIGGER catering_delivery_observation_heads AFTER INSERT ON catering_delivery_observations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_delivery_heads();
REVOKE ALL ON TABLE catering_delivery_jobs,catering_delivery_attempts,catering_delivery_observations FROM PUBLIC;
REVOKE ALL ON FUNCTION catering_delivery_authority_current(public.catering_delivery_jobs),guard_catering_delivery_job(),verify_catering_delivery_origin(),guard_catering_delivery_attempt(),
  guard_catering_delivery_observation(),verify_catering_delivery_heads() FROM PUBLIC;

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
