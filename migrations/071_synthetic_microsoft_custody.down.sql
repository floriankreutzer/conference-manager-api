-- Refuse to erase retained Microsoft custody evidence or relabel its proof kind.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM synthetic_customer_handoffs WHERE approval_microsoft_proof_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SYNTHETIC_MICROSOFT_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
CREATE OR REPLACE FUNCTION assert_synthetic_handoff_approval(value public.synthetic_customer_handoffs) RETURNS void
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

CREATE OR REPLACE FUNCTION guard_synthetic_customer_handoff() RETURNS trigger
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

CREATE OR REPLACE FUNCTION guard_synthetic_handoff_session() RETURNS trigger
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

CREATE OR REPLACE FUNCTION protected_lock_synthetic_calendar_source(scope_environment text,scope_epoch uuid,customer_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_id uuid;actor_version bigint;source_id uuid;person_id uuid;person_version bigint;tenant uuid;
BEGIN
  IF scope_environment IS NULL OR scope_environment NOT IN ('dev','int') OR scope_epoch IS NULL OR customer_session IS NULL
    OR (session_user::text<>('cm_protected_'||scope_environment||'_customer') AND session_user::text<>current_user::text)
    OR NOT pg_try_advisory_xact_lock_shared(740193,CASE scope_environment WHEN 'dev' THEN 1 ELSE 2 END) THEN RETURN false; END IF;
  SELECT custody.operator_id,custody.operator_security_version,custody.source_platform_session_id,
    custody.user_id,custody.user_security_version,custody.tenant_id
    INTO actor_id,actor_version,source_id,person_id,person_version,tenant
    FROM public.synthetic_customer_handoffs custody
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=custody.environment
      AND deployment.security_epoch=custody.security_epoch
    WHERE custody.environment=scope_environment AND custody.security_epoch=scope_epoch
      AND custody.customer_session_id=customer_session AND custody.status='consumed';
  IF NOT FOUND THEN RETURN false; END IF;
  -- Avoid a Tenant -> actor blocking upgrade against an in-flight Platform
  -- operation. Mutable custody locks are retained through the caller's commit;
  -- contention/serialization cannot become a stale success or an implicit retry.
  PERFORM id FROM public.platform_operators WHERE id=actor_id AND security_version=actor_version
    AND provider='microsoft_entra_platform' AND status='active' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.platform_sessions WHERE id=source_id AND operator_id=actor_id
    AND principal_version=actor_version AND revoked_at IS NULL AND expires_at>clock_timestamp()
    AND assurance_level='mfa' AND authentication_context='cm:pk:v1' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.users WHERE tenant_id=tenant AND id=person_id AND active=true
    AND security_version=person_version FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.sessions WHERE id=customer_session AND tenant_id=tenant AND user_id=person_id
    AND principal_version=person_version AND provider='platform_delegation' AND revoked_at IS NULL
    AND expires_at>clock_timestamp() FOR SHARE NOWAIT;
  RETURN FOUND;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
DROP FUNCTION assert_legacy_synthetic_handoff_approval(public.synthetic_customer_handoffs);
ALTER TABLE synthetic_customer_handoffs DROP CONSTRAINT synthetic_handoff_exact_approval_kind;
ALTER TABLE synthetic_customer_handoffs DROP COLUMN approval_microsoft_proof_id;
ALTER TABLE synthetic_customer_handoffs ADD CONSTRAINT synthetic_handoff_exact_approval_kind
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
          AND consumed_at>=approved_at AND consumed_at<code_expires_at))));
