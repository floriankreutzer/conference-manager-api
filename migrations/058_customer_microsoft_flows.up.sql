-- Prepared invited-only Microsoft login/link custody. No existing identity,
-- membership, provider binding, role, session or runtime mode is changed.
CREATE FUNCTION customer_microsoft_snapshot_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE entry jsonb; field text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value)>100 OR octet_length(value::text)>32768 THEN RETURN false; END IF;
  FOR entry IN SELECT x FROM jsonb_array_elements(value) x LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF ARRAY(SELECT jsonb_object_keys(entry) ORDER BY 1)<>ARRAY['membershipId','tenantId','userId','userSecurityVersion']
      THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['membershipId','tenantId','userId'] LOOP
      IF jsonb_typeof(entry->field) IS DISTINCT FROM 'string'
        OR entry->>field !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(entry->'userSecurityVersion') IS DISTINCT FROM 'number'
      OR entry->>'userSecurityVersion' !~ '^[1-9][0-9]{0,15}$' THEN RETURN false; END IF;
    IF (entry->>'userSecurityVersion')::bigint>9007199254740990 THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT x->>'membershipId') FROM jsonb_array_elements(value) x)=jsonb_array_length(value)
    AND (SELECT count(DISTINCT x->>'tenantId') FROM jsonb_array_elements(value) x)=jsonb_array_length(value);
END $$;
REVOKE ALL ON FUNCTION customer_microsoft_snapshot_valid(jsonb) FROM PUBLIC;

CREATE TABLE customer_microsoft_flows (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  id uuid NOT NULL,
  purpose varchar(8) NOT NULL CHECK(purpose IN ('login','link')),
  status varchar(16) NOT NULL DEFAULT 'started' CHECK(status IN ('started','redeeming','verified','consumed','failed')),
  state_hash varchar(64) NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  nonce_hash varchar(64) NOT NULL CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),
  browser_verifier varchar(64) NOT NULL CHECK(browser_verifier ~ '^[a-f0-9]{64}$'),
  source_key_hash varchar(64) NOT NULL CHECK(source_key_hash ~ '^[a-f0-9]{64}$'),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  redeeming_at timestamptz,
  verified_at timestamptz,
  consumed_at timestamptz,
  failed_at timestamptz,
  choice_verifier varchar(64) CHECK(choice_verifier ~ '^[a-f0-9]{64}$'),
  provider_tenant_reference uuid,
  provider_user_reference uuid,
  authenticated_at timestamptz,
  admission_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(customer_microsoft_snapshot_valid(admission_snapshot)),
  expected_tenant_id uuid,
  expected_user_id uuid,
  expected_membership_id uuid,
  expected_session_id uuid REFERENCES sessions(id) ON DELETE RESTRICT,
  expected_security_version bigint CHECK(expected_security_version BETWEEN 1 AND 9007199254740989),
  selected_tenant_id uuid,
  selected_user_id uuid,
  selected_membership_id uuid,
  selected_security_version bigint CHECK(selected_security_version BETWEEN 1 AND 9007199254740990),
  link_audit_event_id bigint,
  PRIMARY KEY(environment,id),UNIQUE(environment,state_hash),
  FOREIGN KEY(expected_tenant_id,expected_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,expected_tenant_id,expected_membership_id)
    REFERENCES customer_access_memberships(environment,tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(selected_tenant_id,selected_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,selected_tenant_id,selected_membership_id)
    REFERENCES customer_access_memberships(environment,tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(expected_tenant_id,link_audit_event_id) REFERENCES audit_events(tenant_id,id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK(expires_at>=created_at+interval '2 minutes' AND expires_at<=created_at+interval '10 minutes'),
  CHECK((purpose='login' AND expected_tenant_id IS NULL AND expected_user_id IS NULL
      AND expected_membership_id IS NULL AND expected_session_id IS NULL AND expected_security_version IS NULL
      AND link_audit_event_id IS NULL)
    OR (purpose='link' AND expected_tenant_id IS NOT NULL AND expected_user_id IS NOT NULL
      AND expected_membership_id IS NOT NULL AND expected_session_id IS NOT NULL AND expected_security_version IS NOT NULL
      AND admission_snapshot='[]'::jsonb)),
  CHECK(redeeming_at IS NULL OR (redeeming_at>=created_at AND redeeming_at<expires_at)),
  CHECK(verified_at IS NULL OR (redeeming_at IS NOT NULL AND verified_at>=redeeming_at AND verified_at<expires_at)),
  CHECK(consumed_at IS NULL OR (verified_at IS NOT NULL AND consumed_at>=verified_at
    AND consumed_at<expires_at AND consumed_at<verified_at+interval '5 minutes')),
  CHECK(failed_at IS NULL OR failed_at>=created_at),
  CHECK((verified_at IS NULL AND choice_verifier IS NULL AND provider_tenant_reference IS NULL
      AND provider_user_reference IS NULL AND authenticated_at IS NULL AND admission_snapshot='[]'::jsonb)
    OR (verified_at IS NOT NULL AND choice_verifier IS NOT NULL AND provider_tenant_reference IS NOT NULL
      AND provider_user_reference IS NOT NULL AND authenticated_at IS NOT NULL
      AND provider_tenant_reference<>'9188040d-6c67-4c5b-b112-36a304b66dad'::uuid
      AND authenticated_at>=created_at-interval '60 seconds'
      AND authenticated_at>=verified_at-interval '360 seconds' AND authenticated_at<=verified_at+interval '60 seconds')),
  CHECK((status='started' AND redeeming_at IS NULL AND verified_at IS NULL AND consumed_at IS NULL AND failed_at IS NULL)
    OR (status='redeeming' AND redeeming_at IS NOT NULL AND verified_at IS NULL AND consumed_at IS NULL AND failed_at IS NULL)
    OR (status='verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND failed_at IS NULL)
    OR (status='consumed' AND consumed_at IS NOT NULL AND failed_at IS NULL)
    OR (status='failed' AND verified_at IS NULL AND consumed_at IS NULL AND failed_at IS NOT NULL)),
  CHECK((status<>'consumed' AND selected_tenant_id IS NULL AND selected_user_id IS NULL
      AND selected_membership_id IS NULL AND selected_security_version IS NULL AND link_audit_event_id IS NULL)
    OR (status='consumed' AND selected_tenant_id IS NOT NULL AND selected_user_id IS NOT NULL
      AND selected_membership_id IS NOT NULL AND selected_security_version IS NOT NULL
      AND (purpose='login' OR (selected_tenant_id=expected_tenant_id AND selected_user_id=expected_user_id
        AND selected_membership_id=expected_membership_id AND selected_security_version=expected_security_version+1
        AND link_audit_event_id IS NOT NULL))))
);
CREATE INDEX customer_microsoft_flow_retention_idx ON customer_microsoft_flows(environment,expires_at,id)
  WHERE NOT (purpose='link' AND status='consumed');

CREATE TABLE customer_microsoft_start_budgets (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  kind varchar(8) NOT NULL CHECK(kind IN ('global','source')),
  key_hash varchar(64) NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issue_count integer NOT NULL CHECK(issue_count BETWEEN 1 AND 100),
  last_issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,kind,key_hash),CHECK(last_issued_at>=window_started_at)
);
CREATE INDEX customer_microsoft_start_budget_retention_idx
  ON customer_microsoft_start_budgets(environment,window_started_at,kind,key_hash);

CREATE FUNCTION guard_customer_microsoft_flow() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE allowed text[]; now_at timestamptz:=clock_timestamp();
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.expires_at<now_at-interval '1 hour' AND NOT (OLD.purpose='link' AND OLD.status='consumed') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'CUSTOMER_MICROSOFT_FLOW_RETENTION_DENIED' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'started' OR NEW.created_at>now_at+interval '1 second' THEN
      RAISE EXCEPTION 'CUSTOMER_MICROSOFT_FLOW_MUST_BEGIN_PENDING' USING ERRCODE='23514'; END IF;
    IF NEW.purpose='link' AND NOT EXISTS(SELECT 1 FROM public.sessions session
      JOIN public.users person ON person.tenant_id=session.tenant_id AND person.id=session.user_id
      JOIN public.tenants tenant ON tenant.id=person.tenant_id
      JOIN public.customer_access_memberships member ON member.environment=NEW.environment
        AND member.tenant_id=person.tenant_id AND member.user_id=person.id AND member.id=NEW.expected_membership_id
      JOIN public.user_identity_bindings identity ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id
        AND identity.provider='email_code' AND identity.provider_tenant_reference=NEW.environment
        AND identity.provider_user_reference=member.mailbox_id::text
      WHERE session.id=NEW.expected_session_id AND session.tenant_id=NEW.expected_tenant_id AND session.user_id=NEW.expected_user_id
        AND session.provider='email_code' AND session.provider_identity_reference=member.mailbox_id::text
        AND session.principal_version=NEW.expected_security_version AND person.security_version=NEW.expected_security_version
        AND person.active=true AND tenant.status IN ('pending','onboarding','ready','active') AND member.accepted_at IS NOT NULL
        AND session.revoked_at IS NULL AND session.expires_at>now_at AND session.issued_at<=now_at+interval '1 second'
        AND session.issued_at>=now_at-interval '5 minutes') THEN
      RAISE EXCEPTION 'CUSTOMER_MICROSOFT_FRESH_EMAIL_SESSION_REQUIRED' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='started' AND NEW.status='redeeming' THEN allowed:=ARRAY['status','redeeming_at'];
  ELSIF OLD.status IN ('started','redeeming') AND NEW.status='failed' THEN allowed:=ARRAY['status','failed_at'];
  ELSIF OLD.status='redeeming' AND NEW.status='verified' THEN
    allowed:=ARRAY['status','verified_at','choice_verifier','provider_tenant_reference','provider_user_reference',
      'authenticated_at','admission_snapshot'];
  ELSIF OLD.status='verified' AND NEW.status='consumed' THEN
    allowed:=ARRAY['status','consumed_at','selected_tenant_id','selected_user_id','selected_membership_id',
      'selected_security_version','link_audit_event_id'];
  ELSE RAISE EXCEPTION 'CUSTOMER_MICROSOFT_FLOW_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  IF to_jsonb(NEW)-allowed IS DISTINCT FROM to_jsonb(OLD)-allowed
    OR (NEW.redeeming_at IS DISTINCT FROM OLD.redeeming_at AND NEW.redeeming_at>now_at+interval '1 second')
    OR (NEW.verified_at IS DISTINCT FROM OLD.verified_at AND NEW.verified_at>now_at+interval '1 second')
    OR (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at AND NEW.consumed_at>now_at+interval '1 second')
    OR (NEW.failed_at IS DISTINCT FROM OLD.failed_at AND NEW.failed_at>now_at+interval '1 second') THEN
    RAISE EXCEPTION 'CUSTOMER_MICROSOFT_FLOW_SCOPE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_customer_microsoft_flow() FROM PUBLIC;
CREATE TRIGGER customer_microsoft_flow_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_microsoft_flows
  FOR EACH ROW EXECUTE FUNCTION guard_customer_microsoft_flow();

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (action IN (
  'session.issued','session.revoked','session.rotated',
  'authentication.failed','authorization.denied','request.started',
  'request.abandoned','request.created','request.transition',
  'request.transition_failed','request.booking_change','tenant.configuration.changed',
  'tenant.user_permissions.changed','tenant.entitlement.changed','tenant.lifecycle.changed',
  'tenant.onboarding.invited','tenant.identity.claimed','tenant.identity.unbound',
  'tenant.user.provisioned','tenant.user.identity_linked','tenant.user.profile_updated','integration.connected',
  'integration.disconnected','integration.admin_consent.changed','integration.verified',
  'calendar.operation','catering.catalogue.received','catering.catalogue.published','catering.catalogue.rejected','catering.order.prepared',
  'catering.order.quoted','catering.order.decided','catering.delivery.queued',
  'catering.delivery.claimed','catering.delivery.attempted','catering.delivery.observed',
  'catering.delivery.deferred','catering.delivery.recovered','catering.order.version_proposed',
  'catering.order.withdrawn','catering.order.unsent_replaced','catering.manual.transmitted',
  'catering.manual.receipt','audit.read'
));

CREATE FUNCTION verify_customer_microsoft_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.purpose<>'link' OR NEW.status<>'consumed' THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.customer_access_memberships member
    JOIN public.users person ON person.tenant_id=member.tenant_id AND person.id=member.user_id
    JOIN public.tenants tenant ON tenant.id=person.tenant_id
    JOIN public.sessions previous_session ON previous_session.id=NEW.expected_session_id
      AND previous_session.tenant_id=person.tenant_id AND previous_session.user_id=person.id
    JOIN public.user_identity_bindings email_identity ON email_identity.tenant_id=person.tenant_id AND email_identity.user_id=person.id
      AND email_identity.provider='email_code' AND email_identity.provider_tenant_reference=NEW.environment
      AND email_identity.provider_user_reference=member.mailbox_id::text
    JOIN public.user_identity_bindings identity ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id
      AND identity.provider='microsoft_entra' AND identity.provider_tenant_reference=NEW.provider_tenant_reference::text
      AND identity.provider_user_reference=NEW.provider_user_reference::text
    JOIN public.audit_events event ON event.tenant_id=person.tenant_id AND event.id=NEW.link_audit_event_id
    WHERE member.environment=NEW.environment AND member.tenant_id=NEW.expected_tenant_id
      AND member.id=NEW.expected_membership_id AND member.user_id=NEW.expected_user_id AND member.accepted_at IS NOT NULL
      AND person.active=true AND person.security_version=NEW.selected_security_version
      AND tenant.status IN ('pending','onboarding','ready','active')
      AND previous_session.provider='email_code' AND previous_session.provider_identity_reference=member.mailbox_id::text
      AND previous_session.principal_version=NEW.expected_security_version AND previous_session.revoked_at IS NULL
      AND previous_session.issued_at<=NEW.consumed_at AND previous_session.issued_at>=NEW.consumed_at-interval '5 minutes'
      AND previous_session.expires_at>NEW.consumed_at
      AND NEW.authenticated_at>=NEW.consumed_at-interval '360 seconds'
      AND event.action='tenant.user.identity_linked' AND event.actor_user_id=person.id
      AND event.target_type='user' AND event.target_id=person.id::text AND event.outcome='success'
      AND event.correlation_id=NEW.correlation_id AND event.occurred_at=NEW.consumed_at
      AND event.previous_state->>'securityVersion'=NEW.expected_security_version::text
      AND event.new_state->>'securityVersion'=NEW.selected_security_version::text
      AND event.metadata->>'provider'='microsoft_entra' AND event.metadata->>'source'='explicit_link')
  THEN RAISE EXCEPTION 'CUSTOMER_MICROSOFT_LINK_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION verify_customer_microsoft_link() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER customer_microsoft_link_evidence_required AFTER INSERT OR UPDATE ON customer_microsoft_flows
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_customer_microsoft_link();

CREATE FUNCTION guard_customer_microsoft_identity_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE admitted boolean;
BEGIN
  -- This read-only constraint also runs for closed Demo seed bindings. Those
  -- roles retain zero CRUD/EXECUTE access to real invitation/proof custody.
  IF TG_RELID<>'public.user_identity_bindings'::regclass OR TG_NAME<>'customer_microsoft_identity_link_required'
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'CUSTOMER_MICROSOFT_LINK_TRIGGER_CONTEXT_REQUIRED' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.provider='microsoft_entra' AND EXISTS(SELECT 1 FROM public.customer_access_memberships
      WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id AND accepted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'CUSTOMER_MICROSOFT_IDENTITY_REQUIRES_EXPLICIT_UNLINK' USING ERRCODE='55000'; END IF;
    RETURN NULL;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.provider='microsoft_entra' OR NEW.provider='microsoft_entra')
    AND EXISTS(SELECT 1 FROM public.customer_access_memberships WHERE accepted_at IS NOT NULL
      AND ((tenant_id=OLD.tenant_id AND user_id=OLD.user_id) OR (tenant_id=NEW.tenant_id AND user_id=NEW.user_id))) THEN
    IF (NEW.tenant_id,NEW.provider,NEW.provider_tenant_reference,NEW.provider_user_reference,NEW.user_id)
      IS DISTINCT FROM (OLD.tenant_id,OLD.provider,OLD.provider_tenant_reference,OLD.provider_user_reference,OLD.user_id) THEN
      RAISE EXCEPTION 'CUSTOMER_MICROSOFT_IDENTITY_LINK_IMMUTABLE' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF NEW.provider<>'microsoft_entra' THEN RETURN NULL; END IF;
  SELECT EXISTS(SELECT 1 FROM public.customer_access_memberships WHERE tenant_id=NEW.tenant_id
    AND user_id=NEW.user_id AND accepted_at IS NOT NULL) INTO admitted;
  IF admitted AND NOT EXISTS(SELECT 1 FROM public.customer_microsoft_flows flow
    WHERE flow.purpose='link' AND flow.status='consumed' AND flow.expected_tenant_id=NEW.tenant_id
      AND flow.expected_user_id=NEW.user_id AND flow.provider_tenant_reference::text=NEW.provider_tenant_reference
      AND flow.provider_user_reference::text=NEW.provider_user_reference AND flow.link_audit_event_id IS NOT NULL)
  THEN RAISE EXCEPTION 'CUSTOMER_MICROSOFT_EXPLICIT_LINK_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_customer_microsoft_identity_link() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER customer_microsoft_identity_link_required AFTER INSERT OR UPDATE OR DELETE ON user_identity_bindings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_customer_microsoft_identity_link();

CREATE FUNCTION guard_customer_microsoft_start_budget() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.last_issued_at<clock_timestamp()-interval '24 hours' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'CUSTOMER_MICROSOFT_BUDGET_RETENTION_DENIED' USING ERRCODE='55000';
  END IF;
  IF (NEW.environment,NEW.kind,NEW.key_hash) IS DISTINCT FROM (OLD.environment,OLD.kind,OLD.key_hash)
    OR NEW.last_issued_at<OLD.last_issued_at OR NEW.last_issued_at>clock_timestamp()+interval '1 second'
    OR NOT ((NEW.window_started_at=OLD.window_started_at AND NEW.issue_count=OLD.issue_count+1)
      OR (NEW.window_started_at>=OLD.window_started_at+interval '1 minute' AND NEW.issue_count=1)) THEN
    RAISE EXCEPTION 'CUSTOMER_MICROSOFT_BUDGET_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_customer_microsoft_start_budget() FROM PUBLIC;
CREATE TRIGGER customer_microsoft_start_budget_guard BEFORE UPDATE OR DELETE ON customer_microsoft_start_budgets
  FOR EACH ROW EXECUTE FUNCTION guard_customer_microsoft_start_budget();
