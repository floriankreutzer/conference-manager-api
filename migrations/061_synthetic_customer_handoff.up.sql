-- Private one-use browser custody only. No session, operator, Tenant or epoch is activated.
CREATE TABLE synthetic_customer_handoffs (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int')),
  id uuid NOT NULL,
  global_slot integer NOT NULL CONSTRAINT synthetic_handoff_global_slot_valid CHECK(global_slot BETWEEN 1 AND 5000),
  owner_slot integer CONSTRAINT synthetic_handoff_owner_slot_valid CHECK(owner_slot BETWEEN 1 AND 512),
  security_epoch uuid NOT NULL,
  platform_security_epoch bigint NOT NULL CHECK(platform_security_epoch>=1),
  customer_origin varchar(253) NOT NULL CHECK(customer_origin ~ '^https://' AND customer_origin !~ '[[:cntrl:]]'),
  platform_origin varchar(253) NOT NULL CHECK(platform_origin ~ '^https://' AND platform_origin !~ '[[:cntrl:]]'),
  state_hash char(64) NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  browser_verifier char(64) NOT NULL CHECK(browser_verifier ~ '^[a-f0-9]{64}$'),
  source_key_hash char(64) NOT NULL CHECK(source_key_hash ~ '^[a-f0-9]{64}$'),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','consumed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  operator_id uuid,
  operator_security_version bigint CHECK(operator_security_version>=1),
  generation_id uuid,
  slot varchar(16) CHECK(slot IN ('northwind','contoso','fabrikam')),
  selected_role varchar(32) CHECK(selected_role IN ('employee','conference_manager','tenant_admin')),
  tenant_id uuid,
  user_id uuid,
  user_security_version bigint CHECK(user_security_version>=1),
  source_platform_session_id uuid REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  approval_proof_id uuid UNIQUE REFERENCES platform_passkey_auth_transactions(id) ON DELETE RESTRICT,
  operation_hash char(64) CHECK(operation_hash ~ '^[a-f0-9]{64}$'),
  approval_audit_sequence bigint REFERENCES platform_audit_events(sequence) ON DELETE RESTRICT,
  code_verifier char(64) CHECK(code_verifier ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz,
  code_expires_at timestamptz,
  customer_session_id uuid UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  consumed_at timestamptz,
  PRIMARY KEY(environment,id),UNIQUE(environment,security_epoch,state_hash),
  UNIQUE(environment,global_slot),UNIQUE(environment,operator_id,owner_slot),
  FOREIGN KEY(environment) REFERENCES protected_runtime_deployments(environment) ON DELETE RESTRICT,
  FOREIGN KEY(environment,security_epoch) REFERENCES protected_runtime_epoch_history(environment,security_epoch) ON DELETE RESTRICT,
  FOREIGN KEY(environment,generation_id,operator_id)
    REFERENCES synthetic_tenant_generations(environment,id,operator_id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,tenant_id) REFERENCES tenant_runtime_registry(environment,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK(customer_origin<>platform_origin),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK((status='pending' AND owner_slot IS NULL AND operator_id IS NULL AND operator_security_version IS NULL AND generation_id IS NULL
      AND slot IS NULL AND selected_role IS NULL AND tenant_id IS NULL AND user_id IS NULL AND user_security_version IS NULL
      AND source_platform_session_id IS NULL AND approval_proof_id IS NULL AND operation_hash IS NULL
      AND approval_audit_sequence IS NULL AND code_verifier IS NULL AND approved_at IS NULL AND code_expires_at IS NULL
      AND customer_session_id IS NULL AND consumed_at IS NULL)
    OR (status IN ('approved','consumed') AND owner_slot IS NOT NULL AND operator_id IS NOT NULL AND operator_security_version IS NOT NULL
      AND generation_id IS NOT NULL AND slot IS NOT NULL AND selected_role IS NOT NULL AND tenant_id IS NOT NULL
      AND user_id IS NOT NULL AND user_security_version IS NOT NULL AND source_platform_session_id IS NOT NULL
      AND approval_proof_id IS NOT NULL AND operation_hash IS NOT NULL AND approval_audit_sequence IS NOT NULL
      AND code_verifier IS NOT NULL AND approved_at IS NOT NULL AND code_expires_at IS NOT NULL
      AND approved_at>=created_at AND code_expires_at>approved_at AND code_expires_at<=approved_at+interval '60 seconds'
      AND code_expires_at<=expires_at
      AND ((status='approved' AND customer_session_id IS NULL AND consumed_at IS NULL)
        OR (status='consumed' AND customer_session_id IS NOT NULL AND consumed_at IS NOT NULL
          AND consumed_at>=approved_at AND consumed_at<code_expires_at))))
);
CREATE INDEX synthetic_handoff_expiry_idx ON synthetic_customer_handoffs(environment,expires_at,id);
CREATE INDEX synthetic_handoff_owner_idx ON synthetic_customer_handoffs(environment,operator_id,created_at,id);
CREATE INDEX synthetic_handoff_consumed_idx ON synthetic_customer_handoffs(environment,consumed_at,id) WHERE status='consumed';

CREATE TABLE synthetic_handoff_start_budgets (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int')),
  kind varchar(8) NOT NULL CHECK(kind IN ('source','global')),
  key_hash char(64) NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  issue_count integer NOT NULL CHECK(issue_count BETWEEN 0 AND 30),
  last_issued_at timestamptz NOT NULL,
  PRIMARY KEY(environment,kind,key_hash),
  FOREIGN KEY(environment) REFERENCES protected_runtime_deployments(environment) ON DELETE RESTRICT,
  CHECK(last_issued_at>=window_started_at)
);
CREATE INDEX synthetic_handoff_budget_expiry_idx ON synthetic_handoff_start_budgets(environment,last_issued_at,kind,key_hash);
REVOKE ALL ON TABLE synthetic_customer_handoffs,synthetic_handoff_start_budgets FROM PUBLIC;

-- Private invariant shared by the two exact-context, read-only trigger parents.
-- Not a data-returning API, not SECURITY DEFINER, and not executable by PUBLIC.
CREATE FUNCTION assert_synthetic_handoff_approval(value public.synthetic_customer_handoffs) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_TRIGGER_CONTEXT_REQUIRED' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.tenant_runtime_registry registry
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=registry.environment
      AND deployment.security_epoch=value.security_epoch
    JOIN public.synthetic_tenant_generations generation ON generation.environment=registry.environment
      AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
    JOIN public.platform_operators actor ON actor.id=generation.operator_id
    JOIN public.tenants tenant ON tenant.id=registry.tenant_id
    JOIN public.users person ON person.tenant_id=tenant.id AND person.id=value.user_id
    JOIN public.user_identity_bindings identity ON identity.tenant_id=tenant.id AND identity.user_id=person.id
      AND identity.provider='platform_delegation' AND identity.provider_tenant_reference=generation.id::text
      AND identity.provider_user_reference=actor.id::text||':'||value.selected_role
    JOIN public.platform_sessions source ON source.id=value.source_platform_session_id AND source.operator_id=actor.id
    JOIN public.platform_passkey_auth_transactions proof ON proof.id=value.approval_proof_id AND proof.operator_id=actor.id
    JOIN public.platform_audit_events evidence ON evidence.sequence=value.approval_audit_sequence AND evidence.operator_id=actor.id
    WHERE registry.environment=value.environment AND registry.tenant_id=value.tenant_id AND registry.mode='synthetic'
      AND registry.generation_id=value.generation_id AND registry.operator_id=value.operator_id AND registry.slot=value.slot
      AND generation.state='active' AND generation.security_epoch=value.security_epoch
      AND generation.operator_security_version=value.operator_security_version
      AND actor.provider='microsoft_entra_platform' AND actor.status='active' AND actor.security_version=value.operator_security_version
      AND tenant.status IN ('onboarding','ready','active') AND person.active=true AND person.security_version=value.user_security_version
      AND source.provider=actor.provider AND source.provider_tenant_reference=actor.provider_tenant_reference
      AND source.provider_subject_reference=actor.provider_subject_reference AND source.principal_version=actor.security_version
      AND source.roles=actor.roles AND source.scope_mode=actor.scope_mode AND source.assurance_level='mfa'
      AND source.authentication_context='cm:pk:v1' AND source.security_epoch=value.platform_security_epoch
      AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp() AND source.issued_at<=clock_timestamp()+interval '1 minute'
      AND 'platform:lifecycle:manage'=ANY(source.permissions)
      AND proof.environment=value.environment AND proof.security_epoch=value.platform_security_epoch
      AND proof.operator_security_version=value.operator_security_version AND proof.purpose='step_up'
      AND proof.operation_hash=value.operation_hash AND proof.expected_session_id<>source.id
      AND proof.consumed_at IS NOT NULL AND proof.consumed_at<proof.expires_at
      AND date_trunc('milliseconds',proof.consumed_at)=source.authenticated_at
      AND value.approved_at>=date_trunc('milliseconds',proof.consumed_at)
      AND value.approved_at<=date_trunc('milliseconds',proof.consumed_at)+interval '30 seconds'
      AND evidence.action='platform.synthetic_access.approved' AND evidence.target_tenant_id=tenant.id
      AND evidence.outcome='success' AND evidence.assurance_level='step_up'
      AND evidence.metadata=jsonb_build_object('mode','synthetic','generationId',generation.id::text,
        'slot',registry.slot,'role',value.selected_role)
      AND (SELECT count(*) FROM public.platform_passkey_credentials key
        WHERE key.operator_id=actor.id AND key.environment=value.environment AND key.revoked_at IS NULL)>=2
      AND NOT EXISTS(SELECT 1 FROM public.tenant_user_roles elevation WHERE elevation.tenant_id=person.tenant_id
        AND elevation.user_id=person.id AND elevation.role<>value.selected_role)
      AND ((value.selected_role='employee' AND NOT EXISTS(SELECT 1 FROM public.tenant_user_roles elevation
          WHERE elevation.tenant_id=person.tenant_id AND elevation.user_id=person.id))
        OR (value.selected_role<>'employee' AND EXISTS(SELECT 1 FROM public.tenant_user_roles elevation
          WHERE elevation.tenant_id=person.tenant_id AND elevation.user_id=person.id AND elevation.role=value.selected_role)))
    FOR SHARE OF deployment,generation,actor,tenant,person,source,proof;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHETIC_HANDOFF_APPROVAL_DENIED' USING ERRCODE='23514'; END IF;
END $$;
REVOKE ALL ON FUNCTION assert_synthetic_handoff_approval(public.synthetic_customer_handoffs) FROM PUBLIC;

CREATE FUNCTION guard_synthetic_customer_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope integer;
BEGIN
  IF TG_RELID<>'public.synthetic_customer_handoffs'::regclass OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
    OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status='consumed' AND EXISTS(SELECT 1 FROM public.sessions session WHERE session.id=OLD.customer_session_id
      AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'SYNTHETIC_HANDOFF_ACTIVE_SESSION_REQUIRES_CUSTODY' USING ERRCODE='55000'; END IF;
    IF (OLD.status<>'consumed' AND OLD.expires_at>=clock_timestamp())
      OR (OLD.status='consumed' AND OLD.consumed_at>=clock_timestamp()-interval '24 hours') THEN
      RAISE EXCEPTION 'SYNTHETIC_HANDOFF_RETENTION_REQUIRED' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  scope:=CASE NEW.environment WHEN 'dev' THEN 1 WHEN 'int' THEN 2 ELSE NULL END;
  IF scope IS NULL OR NOT pg_try_advisory_xact_lock_shared(740193,scope) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_BUSY' USING ERRCODE='55P03'; END IF;
  PERFORM 1 FROM public.protected_runtime_deployments WHERE environment=NEW.environment
    AND security_epoch=NEW.security_epoch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHETIC_HANDOFF_EPOCH_STALE' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' THEN
      RAISE EXCEPTION 'SYNTHETIC_HANDOFF_START_REQUIRED' USING ERRCODE='23514'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('synthetic-handoff-start-v1'),hashtext(NEW.environment)) THEN
      RAISE EXCEPTION 'SYNTHETIC_HANDOFF_START_BUSY' USING ERRCODE='55P03'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.environment,NEW.id,NEW.global_slot,NEW.security_epoch,NEW.platform_security_epoch,NEW.customer_origin,NEW.platform_origin,
      NEW.state_hash,NEW.browser_verifier,NEW.source_key_hash,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.environment,OLD.id,OLD.global_slot,OLD.security_epoch,OLD.platform_security_epoch,OLD.customer_origin,OLD.platform_origin,
      OLD.state_hash,OLD.browser_verifier,OLD.source_key_hash,OLD.created_at,OLD.expires_at)
    OR NOT ((OLD.status='pending' AND NEW.status='approved') OR (OLD.status='approved' AND NEW.status='consumed')) THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  IF OLD.status='pending' THEN
    PERFORM public.protected_runtime_acquire_exclusive(NEW.environment);
    IF NEW.approved_at<clock_timestamp()-interval '30 seconds' OR NEW.approved_at>clock_timestamp()+interval '1 second' THEN
      RAISE EXCEPTION 'SYNTHETIC_HANDOFF_APPROVAL_CAPACITY_OR_TIME_INVALID' USING ERRCODE='23514'; END IF;
  ELSIF (NEW.owner_slot,NEW.operator_id,NEW.operator_security_version,NEW.generation_id,NEW.slot,NEW.selected_role,NEW.tenant_id,NEW.user_id,
      NEW.user_security_version,NEW.source_platform_session_id,NEW.approval_proof_id,NEW.operation_hash,NEW.approval_audit_sequence,
      NEW.code_verifier,NEW.approved_at,NEW.code_expires_at)
    IS DISTINCT FROM (OLD.owner_slot,OLD.operator_id,OLD.operator_security_version,OLD.generation_id,OLD.slot,OLD.selected_role,OLD.tenant_id,OLD.user_id,
      OLD.user_security_version,OLD.source_platform_session_id,OLD.approval_proof_id,OLD.operation_hash,OLD.approval_audit_sequence,
      OLD.code_verifier,OLD.approved_at,OLD.code_expires_at) THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_APPROVAL_IMMUTABLE' USING ERRCODE='23514'; END IF;
  PERFORM public.assert_synthetic_handoff_approval(NEW);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_customer_handoff() FROM PUBLIC;
CREATE TRIGGER synthetic_customer_handoff_guard BEFORE INSERT OR UPDATE OR DELETE ON synthetic_customer_handoffs
  FOR EACH ROW EXECUTE FUNCTION guard_synthetic_customer_handoff();

CREATE FUNCTION guard_synthetic_handoff_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE custody public.synthetic_customer_handoffs%ROWTYPE;expected_roles text[];
BEGIN
  IF TG_RELID<>'public.sessions'::regclass OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
    OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_SESSION_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND OLD.provider='platform_delegation'
    AND (NEW.id,NEW.tenant_id,NEW.user_id,NEW.provider,NEW.provider_identity_reference,NEW.token_hash,NEW.roles,NEW.permissions,
      NEW.principal_version,NEW.issued_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.user_id,OLD.provider,OLD.provider_identity_reference,OLD.token_hash,OLD.roles,OLD.permissions,
      OLD.principal_version,OLD.issued_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_SESSION_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.provider<>'platform_delegation' OR NEW.revoked_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
  SELECT * INTO custody FROM public.synthetic_customer_handoffs WHERE customer_session_id=NEW.id AND status='consumed';
  IF NOT FOUND OR custody.tenant_id<>NEW.tenant_id OR custody.user_id<>NEW.user_id
    OR custody.user_security_version<>NEW.principal_version
    OR NEW.provider_identity_reference<>custody.generation_id::text||':'||custody.operator_id::text||':'||custody.selected_role
    OR NEW.issued_at<custody.approved_at-interval '1 minute' OR NEW.issued_at>custody.consumed_at+interval '1 minute' THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_SESSION_CUSTODY_REQUIRED' USING ERRCODE='23514'; END IF;
  expected_roles:=CASE WHEN custody.selected_role='employee' THEN ARRAY['employee'] ELSE ARRAY['employee',custody.selected_role] END;
  IF NOT (NEW.roles @> expected_roles AND NEW.roles <@ expected_roles AND cardinality(NEW.roles)=cardinality(expected_roles)) THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_SESSION_ROLE_INVALID' USING ERRCODE='23514'; END IF;
  PERFORM public.assert_synthetic_handoff_approval(custody);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_handoff_session() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER synthetic_handoff_session_custody AFTER INSERT OR UPDATE ON sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_synthetic_handoff_session();

CREATE FUNCTION guard_synthetic_handoff_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'TRUNCATE' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT' OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_TRUNCATE_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_RELID='public.synthetic_customer_handoffs'::regclass THEN
    IF EXISTS(SELECT 1 FROM public.synthetic_customer_handoffs LIMIT 1) THEN
      RAISE EXCEPTION 'SYNTHETIC_HANDOFF_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  ELSIF TG_RELID='public.synthetic_handoff_start_budgets'::regclass THEN
    IF EXISTS(SELECT 1 FROM public.synthetic_handoff_start_budgets LIMIT 1) THEN
      RAISE EXCEPTION 'SYNTHETIC_HANDOFF_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  ELSE RAISE EXCEPTION 'SYNTHETIC_HANDOFF_TRUNCATE_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_handoff_truncate() FROM PUBLIC;
CREATE TRIGGER synthetic_customer_handoff_truncate_guard BEFORE TRUNCATE ON synthetic_customer_handoffs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_synthetic_handoff_truncate();
CREATE TRIGGER synthetic_handoff_budget_truncate_guard BEFORE TRUNCATE ON synthetic_handoff_start_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION guard_synthetic_handoff_truncate();

ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_action_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_action_valid CHECK(action IN (
    'platform.authentication.succeeded',
    'platform.authentication.failed',
    'platform.authorization.denied',
    'platform.session.issued',
    'platform.session.rotated',
    'platform.session.revoked',
    'platform.session.epoch_rejected',
    'platform.break_glass.granted',
    'platform.break_glass.revoked',
    'platform.break_glass.used',
    'platform.break_glass.denied',
    'platform.tenant.directory.read',
    'platform.tenant.registration.changed',
    'platform.tenant.invitation.changed',
    'platform.tenant.lifecycle.changed',
    'platform.tenant.entitlement.changed',
    'platform.tenant.quota.changed',
    'platform.tenant.configuration.changed',
    'platform.tenant.integration.changed',
    'platform.tenant.readiness.read',
    'platform.diagnostics.read',
    'platform.metering.read',
    'platform.runtime.read',
    'platform.recovery.previewed',
    'platform.recovery.executed',
    'platform.audit.read',
    'platform.audit.exported',
    'platform.operator.changed',
    'platform.synthetic_access.approved'
  ));
