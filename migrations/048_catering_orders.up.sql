-- No historical Request is backfilled, released or queued by this migration.
CREATE TABLE catering_orders (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id varchar(128) NOT NULL,
  integration_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  creation_command_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,request_id,integration_id),
  UNIQUE (tenant_id,id,request_id,integration_id),
  FOREIGN KEY (tenant_id,request_id) REFERENCES requests(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id)
    REFERENCES catering_integration_configurations(tenant_id,integration_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE catering_order_versions (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740990),
  previous_version bigint GENERATED ALWAYS AS (CASE WHEN version>1 THEN version-1 ELSE NULL END) STORED,
  request_id varchar(128) NOT NULL,
  request_version bigint NOT NULL,
  integration_id uuid NOT NULL,
  assignment_revision bigint NOT NULL,
  catalogue_revision bigint NOT NULL,
  configuration_revision bigint NOT NULL,
  operation varchar(16) NOT NULL CHECK (operation IN ('initial','change','cancel','exception')),
  position_count integer NOT NULL CHECK (position_count BETWEEN 1 AND 101),
  conference_total_minor bigint NOT NULL CHECK (conference_total_minor BETWEEN 0 AND 9007199254740990),
  currency char(3) NOT NULL CHECK (currency IN ('CHF','EUR','GBP','USD')),
  created_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,order_id,version),
  FOREIGN KEY (tenant_id,order_id,request_id,integration_id)
    REFERENCES catering_orders(tenant_id,id,request_id,integration_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,request_id,request_version)
    REFERENCES request_revisions(tenant_id,request_id,request_version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,assignment_revision)
    REFERENCES catering_catalogue_assignment_seals(tenant_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,catalogue_revision) REFERENCES tenant_catalogue_revisions(tenant_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,configuration_revision)
    REFERENCES catering_integration_configuration_revisions(tenant_id,integration_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((version=1 AND operation='initial') OR (version>1 AND operation<>'initial'))
);
CREATE TABLE catering_order_positions (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  version bigint NOT NULL,
  position_id uuid NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('item','package')),
  entry_id varchar(128) NOT NULL CHECK (entry_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  PRIMARY KEY (tenant_id,order_id,version,position_id),
  UNIQUE (tenant_id,order_id,version,kind,entry_id),
  FOREIGN KEY (tenant_id,order_id,version) REFERENCES catering_order_versions(tenant_id,order_id,version) ON DELETE RESTRICT
);
CREATE TABLE catering_order_version_seals (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  version bigint NOT NULL,
  PRIMARY KEY (tenant_id,order_id,version),
  FOREIGN KEY (tenant_id,order_id,version) REFERENCES catering_order_versions(tenant_id,order_id,version) ON DELETE RESTRICT
);
CREATE TABLE catering_order_heads (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  current_version bigint NOT NULL CHECK (current_version BETWEEN 1 AND 9007199254740990),
  PRIMARY KEY (tenant_id,order_id),
  FOREIGN KEY (tenant_id,order_id,current_version) REFERENCES catering_order_version_seals(tenant_id,order_id,version)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE catering_order_versions ADD CONSTRAINT catering_order_previous_version_fk
  FOREIGN KEY (tenant_id,order_id,previous_version) REFERENCES catering_order_version_seals(tenant_id,order_id,version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE catering_order_quotes (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  version bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  previous_revision bigint GENERATED ALWAYS AS (CASE WHEN revision>1 THEN revision-1 ELSE NULL END) STORED,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740990),
  currency char(3) NOT NULL CHECK (currency IN ('CHF','EUR','GBP','USD')),
  source varchar(8) NOT NULL CHECK (source IN ('manual','api')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  recorded_by_user_id uuid,
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,order_id,version,revision),
  UNIQUE (tenant_id,order_id,version,revision,amount_minor,currency),
  FOREIGN KEY (tenant_id,order_id,version) REFERENCES catering_order_version_seals(tenant_id,order_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,recorded_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,version,previous_revision)
    REFERENCES catering_order_quotes(tenant_id,order_id,version,revision) ON DELETE RESTRICT,
  CHECK (source<>'manual' OR recorded_by_user_id IS NOT NULL)
);
CREATE TABLE catering_order_decisions (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  version bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740990),
  previous_sequence bigint GENERATED ALWAYS AS (CASE WHEN sequence>1 THEN sequence-1 ELSE NULL END) STORED,
  quote_revision bigint NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  decision varchar(8) NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_at timestamptz NOT NULL,
  decider_user_id uuid NOT NULL,
  decider_security_version bigint NOT NULL CHECK (decider_security_version BETWEEN 1 AND 9007199254740990),
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,order_id,version,sequence),
  FOREIGN KEY (tenant_id,order_id,version,quote_revision,amount_minor,currency)
    REFERENCES catering_order_quotes(tenant_id,order_id,version,revision,amount_minor,currency) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,decider_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,version,previous_sequence)
    REFERENCES catering_order_decisions(tenant_id,order_id,version,sequence) ON DELETE RESTRICT
);
CREATE TABLE catering_order_version_states (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  version bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  status varchar(32) NOT NULL CHECK (status IN ('pending_quote','pending_manager_review','released','queued',
    'dispatching','reconciliation_required','transmitted','confirmed','partially_confirmed','rejected','cancelled','failed')),
  quote_revision bigint,
  decision_sequence bigint,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,order_id,version),
  FOREIGN KEY (tenant_id,order_id,version) REFERENCES catering_order_version_seals(tenant_id,order_id,version)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,order_id,version,quote_revision)
    REFERENCES catering_order_quotes(tenant_id,order_id,version,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,order_id,version,decision_sequence)
    REFERENCES catering_order_decisions(tenant_id,order_id,version,sequence) DEFERRABLE INITIALLY DEFERRED,
  CHECK (decision_sequence IS NULL OR quote_revision IS NOT NULL),
  CHECK (status NOT IN ('released','queued','dispatching','transmitted','confirmed','partially_confirmed','cancelled')
    OR quote_revision IS NOT NULL)
);

CREATE FUNCTION reject_catering_order_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'CATERING_ORDER_HISTORY_APPEND_ONLY' USING ERRCODE='55000';
END $$;
CREATE TRIGGER catering_order_identity_append_only BEFORE UPDATE OR DELETE ON catering_orders
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_order_version_append_only BEFORE UPDATE OR DELETE ON catering_order_versions
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_order_position_append_only BEFORE UPDATE OR DELETE ON catering_order_positions
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_order_seal_append_only BEFORE UPDATE OR DELETE ON catering_order_version_seals
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_order_quote_append_only BEFORE UPDATE OR DELETE ON catering_order_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_order_decision_append_only BEFORE UPDATE OR DELETE ON catering_order_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION guard_catering_order_head()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_version<>1 THEN
      RAISE EXCEPTION 'CATERING_ORDER_HEAD_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.order_id) IS DISTINCT FROM (OLD.tenant_id,OLD.order_id)
    OR NEW.current_version<>OLD.current_version+1 THEN
    RAISE EXCEPTION 'CATERING_ORDER_HEAD_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_order_head_guard BEFORE INSERT OR UPDATE ON catering_order_heads
  FOR EACH ROW EXECUTE FUNCTION guard_catering_order_head();

CREATE FUNCTION guard_catering_order_position()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.catering_order_versions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.version FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.catering_order_version_seals
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.version) THEN
    RAISE EXCEPTION 'CATERING_ORDER_VERSION_SEALED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_order_position_guard BEFORE INSERT ON catering_order_positions
  FOR EACH ROW EXECUTE FUNCTION guard_catering_order_position();

CREATE FUNCTION verify_catering_order_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  source_record jsonb;
  catering jsonb;
  source_catalogue_revision bigint;
  assignment_catalogue_revision bigint;
  actual_count integer;
  expected_count integer;
  expected_total bigint;
  unexpected_positions boolean;
BEGIN
  SELECT record INTO STRICT source_record FROM public.request_revisions
    WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id AND request_version=NEW.request_version;
  SELECT catalogue_revision INTO STRICT assignment_catalogue_revision FROM public.catering_catalogue_assignment_revisions
    WHERE tenant_id=NEW.tenant_id AND revision=NEW.assignment_revision;
  source_catalogue_revision:=(source_record->'configurationRevisions'->>'catalogue')::bigint;
  catering:=source_record->'pricing'->'catering';
  IF source_record->>'status' IS DISTINCT FROM 'Confirmed' OR coalesce(source_record->>'schemaVersion','') NOT IN ('2','3')
    OR source_catalogue_revision IS DISTINCT FROM NEW.catalogue_revision
    OR assignment_catalogue_revision IS DISTINCT FROM NEW.catalogue_revision
    OR source_record->'pricing'->>'currency' IS DISTINCT FROM NEW.currency
    OR jsonb_typeof(catering->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CATERING_ORDER_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  WITH expected AS (
    SELECT 'package'::text AS kind,catering->'packageSelection'->'package'->>'id' AS entry_id,
      (catering->'packageSelection'->>'lineTotalMinor')::bigint AS line_total
    WHERE jsonb_typeof(catering->'packageSelection')='object'
    UNION ALL
    SELECT 'item',line->'item'->>'id',(line->>'lineTotalMinor')::bigint
    FROM jsonb_array_elements(catering->'items') line WHERE line->>'includedByPackage'='false'
  ), owned AS (
    SELECT expected.* FROM expected JOIN public.catering_catalogue_assignment_entries assignment
      ON assignment.tenant_id=NEW.tenant_id AND assignment.revision=NEW.assignment_revision
      AND assignment.kind=expected.kind AND assignment.entry_id=expected.entry_id AND assignment.integration_id=NEW.integration_id
  )
  SELECT count(*),coalesce(sum(line_total),0),EXISTS (
    SELECT 1 FROM public.catering_order_positions position
    WHERE position.tenant_id=NEW.tenant_id AND position.order_id=NEW.order_id AND position.version=NEW.version
      AND NOT EXISTS (SELECT 1 FROM owned WHERE owned.kind=position.kind AND owned.entry_id=position.entry_id)
  ) INTO expected_count,expected_total,unexpected_positions FROM owned;
  SELECT count(*) INTO actual_count FROM public.catering_order_positions
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.version;
  IF actual_count<>NEW.position_count OR actual_count<>expected_count OR expected_total<>NEW.conference_total_minor
    OR unexpected_positions THEN RAISE EXCEPTION 'CATERING_ORDER_POSITIONS_INCOMPLETE' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catering_order_version_states
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND version=NEW.version) THEN
    RAISE EXCEPTION 'CATERING_ORDER_STATE_MISSING' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catering_order_heads head
    WHERE head.tenant_id=NEW.tenant_id AND head.order_id=NEW.order_id AND head.current_version>=NEW.version
      AND head.current_version=(SELECT max(version) FROM public.catering_order_versions
        WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id)) THEN
    RAISE EXCEPTION 'CATERING_ORDER_HEAD_INVALID' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.catering_order_version_seals (tenant_id,order_id,version) VALUES (NEW.tenant_id,NEW.order_id,NEW.version);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_order_version_complete AFTER INSERT ON catering_order_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_order_version();

CREATE FUNCTION guard_catering_order_version_state()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.status<>'pending_quote' OR NEW.quote_revision IS NOT NULL OR NEW.decision_sequence IS NOT NULL THEN
      RAISE EXCEPTION 'CATERING_ORDER_STATE_REVISION_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id,NEW.order_id,NEW.version) IS DISTINCT FROM (OLD.tenant_id,OLD.order_id,OLD.version)
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'CATERING_ORDER_STATE_REVISION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_order_state_revision_guard BEFORE INSERT OR UPDATE ON catering_order_version_states
  FOR EACH ROW EXECUTE FUNCTION guard_catering_order_version_state();
CREATE TRIGGER catering_order_head_delete_guard BEFORE DELETE ON catering_order_heads
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_order_state_delete_guard BEFORE DELETE ON catering_order_version_states
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();

CREATE FUNCTION verify_catering_order_review_heads()
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
    OR (latest_quote IS NULL AND state.status<>'pending_quote')
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
CREATE CONSTRAINT TRIGGER catering_order_state_review_heads AFTER INSERT OR UPDATE ON catering_order_version_states
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_order_review_heads();
CREATE CONSTRAINT TRIGGER catering_order_quote_review_heads AFTER INSERT ON catering_order_quotes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_order_review_heads();
CREATE CONSTRAINT TRIGGER catering_order_decision_review_heads AFTER INSERT ON catering_order_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_order_review_heads();
CREATE FUNCTION verify_catering_order_presence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catering_order_heads WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id)
    OR NOT EXISTS (SELECT 1 FROM public.catering_order_versions WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND version=1)
    OR NOT EXISTS (SELECT 1 FROM public.catering_order_version_states
      WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND version=1) THEN
    RAISE EXCEPTION 'CATERING_ORDER_INITIAL_VERSION_MISSING' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_order_initial_presence AFTER INSERT ON catering_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_order_presence();
CREATE INDEX catering_order_tenant_request_lookup ON catering_orders(tenant_id,request_id,id);
REVOKE ALL ON TABLE catering_orders,catering_order_versions,catering_order_positions,catering_order_version_seals,
  catering_order_heads,catering_order_quotes,catering_order_decisions,catering_order_version_states FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_catering_order_history_mutation(),guard_catering_order_head(),guard_catering_order_position(),
  verify_catering_order_version(),guard_catering_order_version_state(),verify_catering_order_review_heads(),
  verify_catering_order_presence() FROM PUBLIC;

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
