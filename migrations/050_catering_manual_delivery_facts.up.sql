-- Manual attestation records external facts. It never sends or retries an order.
CREATE TABLE catering_manual_delivery_facts (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_version bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740990),
  previous_sequence bigint GENERATED ALWAYS AS (CASE WHEN sequence>1 THEN sequence-1 ELSE NULL END) STORED,
  command_id uuid NOT NULL,
  origin_state_revision bigint NOT NULL CHECK (origin_state_revision BETWEEN 1 AND 9007199254740989),
  operation varchar(16) NOT NULL,
  quote_revision bigint NOT NULL,
  decision_sequence bigint NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('transmitted','receipt')),
  channel varchar(16) NOT NULL CHECK (channel IN ('email','telephone','portal','in_person','other')),
  reference varchar(200) NOT NULL CHECK (reference=btrim(reference)
    AND reference ~ '^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,199}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by_user_id uuid NOT NULL,
  actor_security_version bigint NOT NULL CHECK (actor_security_version BETWEEN 1 AND 9007199254740990),
  correlation_id uuid NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('transmitted','confirmed','partially_confirmed','rejected','cancelled')),
  receipt jsonb,
  PRIMARY KEY (tenant_id,order_id,order_version,sequence),
  UNIQUE (tenant_id,command_id),
  FOREIGN KEY (tenant_id,order_id,order_version,operation)
    REFERENCES catering_order_versions(tenant_id,order_id,version,operation) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version,decision_sequence,quote_revision)
    REFERENCES catering_order_decisions(tenant_id,order_id,version,sequence,quote_revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,recorded_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version,previous_sequence)
    REFERENCES catering_manual_delivery_facts(tenant_id,order_id,order_version,sequence) ON DELETE RESTRICT,
  CHECK (occurred_at<=recorded_at),
  CHECK ((kind='transmitted' AND sequence=1 AND receipt IS NULL AND status='transmitted')
    OR (kind='receipt' AND sequence>1 AND receipt IS NOT NULL)),
  CHECK (receipt IS NULL OR octet_length(receipt::text)<=32768)
);
CREATE TABLE catering_manual_delivery_heads (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_version bigint NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 1 AND 9007199254740990),
  PRIMARY KEY (tenant_id,order_id,order_version),
  FOREIGN KEY (tenant_id,order_id,order_version)
    REFERENCES catering_order_version_seals(tenant_id,order_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,order_version,last_sequence)
    REFERENCES catering_manual_delivery_facts(tenant_id,order_id,order_version,sequence) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION guard_catering_manual_delivery_fact()
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
          (CASE NEW.operation WHEN 'initial' THEN configuration.order_mode WHEN 'cancel' THEN configuration.cancel_mode
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
CREATE TRIGGER catering_manual_fact_guard BEFORE INSERT ON catering_manual_delivery_facts
  FOR EACH ROW EXECUTE FUNCTION guard_catering_manual_delivery_fact();
CREATE TRIGGER catering_manual_fact_append_only BEFORE UPDATE OR DELETE ON catering_manual_delivery_facts
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION guard_catering_manual_delivery_head()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.last_sequence<>1) OR (TG_OP='UPDATE' AND (
    (NEW.tenant_id,NEW.order_id,NEW.order_version) IS DISTINCT FROM (OLD.tenant_id,OLD.order_id,OLD.order_version)
      OR NEW.last_sequence<>OLD.last_sequence+1)) THEN
    RAISE EXCEPTION 'CATERING_MANUAL_HEAD_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_manual_head_guard BEFORE INSERT OR UPDATE ON catering_manual_delivery_heads
  FOR EACH ROW EXECUTE FUNCTION guard_catering_manual_delivery_head();
CREATE TRIGGER catering_manual_head_delete_guard BEFORE DELETE ON catering_manual_delivery_heads
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION verify_catering_manual_delivery_head()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  fact public.catering_manual_delivery_facts%ROWTYPE;
  head public.catering_manual_delivery_heads%ROWTYPE;
  state public.catering_order_version_states%ROWTYPE;
BEGIN
  SELECT * INTO STRICT fact FROM public.catering_manual_delivery_facts
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND order_version=NEW.order_version ORDER BY sequence DESC LIMIT 1;
  SELECT * INTO STRICT head FROM public.catering_manual_delivery_heads
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND order_version=NEW.order_version;
  SELECT * INTO STRICT state FROM public.catering_order_version_states
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.order_version;
  IF head.last_sequence<>fact.sequence OR state.revision<>fact.origin_state_revision+1 OR state.status<>fact.status
    OR state.quote_revision IS DISTINCT FROM fact.quote_revision OR state.decision_sequence IS DISTINCT FROM fact.decision_sequence THEN
    RAISE EXCEPTION 'CATERING_MANUAL_FACT_STATE_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_manual_fact_complete AFTER INSERT ON catering_manual_delivery_facts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_manual_delivery_head();
CREATE CONSTRAINT TRIGGER catering_manual_head_complete AFTER INSERT OR UPDATE ON catering_manual_delivery_heads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_manual_delivery_head();

REVOKE ALL ON FUNCTION guard_catering_manual_delivery_fact(),guard_catering_manual_delivery_head(),
  verify_catering_manual_delivery_head() FROM PUBLIC;

REVOKE ALL ON TABLE catering_manual_delivery_facts,catering_manual_delivery_heads FROM PUBLIC;

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
