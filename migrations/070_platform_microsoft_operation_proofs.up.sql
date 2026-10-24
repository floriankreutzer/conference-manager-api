-- Exact-operation custody only. No operator, session, key or runtime is activated.
CREATE TABLE platform_microsoft_operation_proofs (
  id uuid PRIMARY KEY,
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  protected_security_epoch uuid NOT NULL,
  security_epoch bigint NOT NULL CHECK(security_epoch>=1),
  operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  operator_security_version bigint NOT NULL CHECK(operator_security_version>=1),
  expected_session_id uuid NOT NULL REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  execution_scope varchar(9) NOT NULL CHECK(execution_scope IN ('shared','synthetic')),
  state_hash char(64) NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash char(64) NOT NULL CHECK(browser_hash ~ '^[a-f0-9]{64}$'),
  nonce_hash char(64) NOT NULL CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),
  operation_hash char(64) NOT NULL CHECK(operation_hash ~ '^[a-f0-9]{64}$'),
  provider_tenant_reference uuid NOT NULL CHECK(provider_tenant_reference<>'9188040d-6c67-4c5b-b112-36a304b66dad'::uuid),
  provider_subject_reference uuid NOT NULL,
  correlation_id uuid NOT NULL,
  status varchar(8) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','consumed','failed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  authenticated_at timestamptz,
  verified_audit_sequence bigint UNIQUE REFERENCES platform_audit_events(sequence) ON DELETE RESTRICT,
  consumed_at timestamptz,
  failed_at timestamptz,
  UNIQUE(environment,protected_security_epoch,state_hash),
  FOREIGN KEY(environment,protected_security_epoch)
    REFERENCES protected_runtime_epoch_history(environment,security_epoch) ON DELETE RESTRICT,
  CHECK(execution_scope<>'synthetic' OR environment IN ('dev','int')),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '120 seconds'),
  CHECK((verified_at IS NULL AND authenticated_at IS NULL AND verified_audit_sequence IS NULL)
    OR (verified_at IS NOT NULL AND authenticated_at IS NOT NULL AND verified_audit_sequence IS NOT NULL
      AND verified_at>=created_at AND verified_at<expires_at
      AND authenticated_at>=created_at-interval '60 seconds' AND authenticated_at<=verified_at+interval '60 seconds')),
  CHECK((status='pending' AND verified_at IS NULL AND consumed_at IS NULL AND failed_at IS NULL)
    OR (status='verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND failed_at IS NULL)
    OR (status='consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL AND failed_at IS NULL
      AND consumed_at>=verified_at AND consumed_at<expires_at)
    OR (status='failed' AND consumed_at IS NULL AND failed_at IS NOT NULL AND failed_at>=created_at))
);
CREATE INDEX platform_microsoft_proof_owner_expiry_idx ON platform_microsoft_operation_proofs(operator_id,expires_at,id);
CREATE INDEX platform_microsoft_proof_cleanup_idx ON platform_microsoft_operation_proofs(environment,expires_at,id);
REVOKE ALL ON platform_microsoft_operation_proofs FROM PUBLIC;

-- Private trigger-only assertion. No SQL execution or data-returning authority.
CREATE FUNCTION assert_platform_microsoft_operation_source(value public.platform_microsoft_operation_proofs)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_TRIGGER_REQUIRED' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.platform_operators actor
    JOIN public.platform_sessions source ON source.operator_id=actor.id
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=value.environment
      AND deployment.security_epoch=value.protected_security_epoch
    WHERE actor.id=value.operator_id AND actor.security_version=value.operator_security_version AND actor.status='active'
      AND actor.provider='microsoft_entra_platform'
      AND actor.provider_tenant_reference=value.provider_tenant_reference::text
      AND actor.provider_subject_reference=value.provider_subject_reference::text
      AND source.id=value.expected_session_id AND source.provider=actor.provider
      AND source.provider_tenant_reference=actor.provider_tenant_reference
      AND source.provider_subject_reference=actor.provider_subject_reference
      AND source.principal_version=actor.security_version AND source.roles=actor.roles AND source.scope_mode=actor.scope_mode
      AND source.security_epoch=value.security_epoch AND source.assurance_level='mfa'
      AND source.authentication_context='cm:ms:mfa:v1' AND source.step_up_expires_at IS NULL
      AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp()
      AND source.issued_at<=clock_timestamp()+interval '1 minute'
      AND (value.execution_scope='shared' OR 'platform:lifecycle:manage'=ANY(source.permissions))
    FOR SHARE OF actor,source,deployment;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_SOURCE_DENIED' USING ERRCODE='23514'; END IF;
END $$;
REVOKE ALL ON FUNCTION assert_platform_microsoft_operation_source(public.platform_microsoft_operation_proofs) FROM PUBLIC;

CREATE FUNCTION guard_platform_microsoft_operation_proof() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope integer;
BEGIN
  IF TG_RELID<>'public.platform_microsoft_operation_proofs'::regclass OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
    OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_TRIGGER_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.expires_at>=clock_timestamp() OR (OLD.status='consumed' AND OLD.consumed_at>=clock_timestamp()-interval '24 hours') THEN
      RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_RETENTION_REQUIRED' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  scope:=CASE NEW.environment WHEN 'dev' THEN 1 WHEN 'int' THEN 2 WHEN 'prod' THEN 3 ELSE NULL END;
  IF scope IS NULL OR NOT pg_try_advisory_xact_lock_shared(740193,scope) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_BUSY' USING ERRCODE='55P03'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.created_at<clock_timestamp()-interval '1 second'
      OR NEW.created_at>clock_timestamp()+interval '1 second' THEN
      RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_START_REQUIRED' USING ERRCODE='23514'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operator_id::text,714534));
    IF (SELECT count(*) FROM public.platform_microsoft_operation_proofs proof
      WHERE proof.operator_id=NEW.operator_id AND proof.expires_at>clock_timestamp())>=5 THEN
      RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_CAPACITY' USING ERRCODE='23514'; END IF;
  ELSE
    IF (NEW.id,NEW.environment,NEW.protected_security_epoch,NEW.security_epoch,NEW.operator_id,NEW.operator_security_version,
        NEW.expected_session_id,NEW.execution_scope,NEW.state_hash,NEW.browser_hash,NEW.nonce_hash,NEW.operation_hash,
        NEW.provider_tenant_reference,NEW.provider_subject_reference,NEW.correlation_id,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.environment,OLD.protected_security_epoch,OLD.security_epoch,OLD.operator_id,OLD.operator_security_version,
        OLD.expected_session_id,OLD.execution_scope,OLD.state_hash,OLD.browser_hash,OLD.nonce_hash,OLD.operation_hash,
        OLD.provider_tenant_reference,OLD.provider_subject_reference,OLD.correlation_id,OLD.created_at,OLD.expires_at)
      OR NOT ((OLD.status='pending' AND NEW.status IN ('verified','failed'))
        OR (OLD.status='verified' AND NEW.status IN ('consumed','failed'))) THEN
      RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
    IF OLD.status='verified' AND (NEW.verified_at,NEW.authenticated_at,NEW.verified_audit_sequence)
      IS DISTINCT FROM (OLD.verified_at,OLD.authenticated_at,OLD.verified_audit_sequence) THEN
      RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_VERIFICATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
    IF NEW.status='failed' THEN
      IF NEW.failed_at<clock_timestamp()-interval '1 second' OR NEW.failed_at>clock_timestamp()+interval '1 second' THEN
        RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_TIME_INVALID' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.expires_at<=clock_timestamp()
      OR (NEW.status='verified' AND (NEW.verified_at<clock_timestamp()-interval '1 second'
        OR NEW.verified_at>clock_timestamp()+interval '1 second'))
      OR (NEW.status='consumed' AND (NEW.consumed_at<clock_timestamp()-interval '1 second'
        OR NEW.consumed_at>clock_timestamp()+interval '1 second')) THEN
      RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_TIME_INVALID' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public.platform_audit_events evidence WHERE evidence.sequence=NEW.verified_audit_sequence
      AND evidence.operator_id=NEW.operator_id AND evidence.action='platform.authentication.succeeded'
      AND evidence.target_type='platform_microsoft_operation' AND evidence.target_id=NEW.operator_id::text
      AND evidence.target_tenant_id IS NULL AND evidence.outcome='success' AND evidence.assurance_level='step_up'
      AND evidence.correlation_id=NEW.correlation_id
      AND evidence.occurred_at BETWEEN NEW.verified_at-interval '30 seconds' AND NEW.verified_at+interval '1 second'
      AND evidence.metadata=jsonb_build_object('operation','microsoft_operation_verified');
    IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  PERFORM public.assert_platform_microsoft_operation_source(NEW);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_platform_microsoft_operation_proof() FROM PUBLIC;
CREATE TRIGGER platform_microsoft_operation_proof_guard BEFORE INSERT OR UPDATE OR DELETE ON platform_microsoft_operation_proofs
  FOR EACH ROW EXECUTE FUNCTION guard_platform_microsoft_operation_proof();

CREATE FUNCTION guard_empty_platform_microsoft_proofs_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'public.platform_microsoft_operation_proofs'::regclass OR TG_OP<>'TRUNCATE' OR TG_WHEN<>'BEFORE'
    OR TG_LEVEL<>'STATEMENT' OR TG_NAME<>'platform_microsoft_proofs_empty_reset_guard' OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_RESET_CONTEXT_INVALID' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.platform_microsoft_operation_proofs) THEN
    RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_HISTORY_REQUIRES_RECOVERY' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_empty_platform_microsoft_proofs_truncate() FROM PUBLIC;
CREATE TRIGGER platform_microsoft_proofs_empty_reset_guard BEFORE TRUNCATE ON platform_microsoft_operation_proofs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_empty_platform_microsoft_proofs_truncate();
