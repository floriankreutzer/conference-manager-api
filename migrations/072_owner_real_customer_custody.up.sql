-- Separate REAL owner custody. No runtime, identity, grant or session is activated.
CREATE TABLE owner_customer_handoffs (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  id uuid NOT NULL,
  global_slot integer NOT NULL CHECK(global_slot BETWEEN 1 AND 5000),
  owner_slot integer CHECK(owner_slot BETWEEN 1 AND 512),
  security_epoch uuid NOT NULL,
  platform_security_epoch bigint NOT NULL CHECK(platform_security_epoch BETWEEN 1 AND 9007199254740991),
  customer_origin varchar(253) NOT NULL CHECK(customer_origin ~ '^https://' AND customer_origin !~ '[[:cntrl:]]'),
  platform_origin varchar(253) NOT NULL CHECK(platform_origin ~ '^https://' AND platform_origin !~ '[[:cntrl:]]'),
  state_hash char(64) NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  browser_verifier char(64) NOT NULL CHECK(browser_verifier ~ '^[a-f0-9]{64}$'),
  source_key_hash char(64) NOT NULL CHECK(source_key_hash ~ '^[a-f0-9]{64}$'),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','consumed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  operator_id uuid REFERENCES platform_operators(id) ON DELETE RESTRICT,
  operator_security_version bigint CHECK(operator_security_version>=1),
  selected_role varchar(32) CHECK(selected_role IN ('employee','conference_manager','tenant_admin')),
  tenant_id uuid,
  user_id uuid,
  user_security_version bigint CHECK(user_security_version>=1),
  identity_created boolean,
  source_platform_session_id uuid REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  approval_microsoft_proof_id uuid UNIQUE REFERENCES platform_microsoft_operation_proofs(id) ON DELETE RESTRICT,
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
  FOREIGN KEY(environment,tenant_id) REFERENCES tenant_runtime_registry(environment,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK(customer_origin<>platform_origin),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK((status='pending' AND owner_slot IS NULL AND operator_id IS NULL AND operator_security_version IS NULL
      AND selected_role IS NULL AND tenant_id IS NULL AND user_id IS NULL AND user_security_version IS NULL AND identity_created IS NULL
      AND source_platform_session_id IS NULL AND approval_microsoft_proof_id IS NULL AND operation_hash IS NULL
      AND approval_audit_sequence IS NULL AND code_verifier IS NULL AND approved_at IS NULL AND code_expires_at IS NULL
      AND customer_session_id IS NULL AND consumed_at IS NULL)
    OR (status IN ('approved','consumed') AND owner_slot IS NOT NULL AND operator_id IS NOT NULL AND operator_security_version IS NOT NULL
      AND selected_role IS NOT NULL AND tenant_id IS NOT NULL AND user_id IS NOT NULL AND user_security_version IS NOT NULL
      AND identity_created IS NOT NULL AND source_platform_session_id IS NOT NULL AND approval_microsoft_proof_id IS NOT NULL
      AND operation_hash IS NOT NULL AND approval_audit_sequence IS NOT NULL AND code_verifier IS NOT NULL
      AND approved_at IS NOT NULL AND code_expires_at IS NOT NULL AND approved_at>=created_at
      AND code_expires_at>approved_at AND code_expires_at<=approved_at+interval '60 seconds' AND code_expires_at<=expires_at
      AND ((status='approved' AND customer_session_id IS NULL AND consumed_at IS NULL)
        OR (status='consumed' AND customer_session_id IS NOT NULL AND consumed_at IS NOT NULL
          AND consumed_at>=approved_at AND consumed_at<code_expires_at))))
);
CREATE INDEX owner_handoff_expiry_idx ON owner_customer_handoffs(environment,expires_at,id);
CREATE INDEX owner_handoff_owner_idx ON owner_customer_handoffs(environment,operator_id,created_at,id);
CREATE INDEX owner_handoff_consumed_idx ON owner_customer_handoffs(environment,consumed_at,id) WHERE status='consumed';

CREATE TABLE owner_handoff_start_budgets (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  kind varchar(8) NOT NULL CHECK(kind IN ('source','global')),
  key_hash char(64) NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  issue_count integer NOT NULL CHECK(issue_count BETWEEN 0 AND 30),
  last_issued_at timestamptz NOT NULL,
  PRIMARY KEY(environment,kind,key_hash),
  FOREIGN KEY(environment) REFERENCES protected_runtime_deployments(environment) ON DELETE RESTRICT,
  CHECK(last_issued_at>=window_started_at)
);
CREATE INDEX owner_handoff_budget_expiry_idx ON owner_handoff_start_budgets(environment,last_issued_at,kind,key_hash);

-- A stable attribution binding, never an independent role/session grant. The
-- original proof/audit remain referenced, without pinning a browser quota slot.
CREATE TABLE platform_owner_customer_users (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider_tenant_reference uuid NOT NULL,
  provider_subject_reference uuid NOT NULL,
  created_flow_id uuid NOT NULL,
  created_proof_id uuid NOT NULL UNIQUE REFERENCES platform_microsoft_operation_proofs(id) ON DELETE RESTRICT,
  created_audit_sequence bigint NOT NULL UNIQUE REFERENCES platform_audit_events(sequence) ON DELETE RESTRICT,
  created_operation_hash char(64) NOT NULL CHECK(created_operation_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(environment,operator_id,tenant_id),UNIQUE(environment,tenant_id,user_id),
  UNIQUE(environment,operator_id,tenant_id,user_id),
  FOREIGN KEY(environment,tenant_id) REFERENCES tenant_runtime_registry(environment,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE owner_customer_handoffs ADD CONSTRAINT owner_handoff_own_user_fk
  FOREIGN KEY(environment,operator_id,tenant_id,user_id)
  REFERENCES platform_owner_customer_users(environment,operator_id,tenant_id,user_id)
  DEFERRABLE INITIALLY DEFERRED;
REVOKE ALL ON TABLE owner_customer_handoffs,owner_handoff_start_budgets,platform_owner_customer_users FROM PUBLIC;

CREATE FUNCTION owner_customer_user_identifier(scope_environment text,tenant uuid,actor uuid) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  WITH value AS (SELECT sha256(convert_to('owner-customer-user:v1:'||scope_environment||':'||tenant::text||':'||actor::text,'UTF8')) AS bytes),
    encoded AS (SELECT bytes,encode(bytes,'hex') AS hex FROM value)
  SELECT (substr(hex,1,12)||'8'||substr(hex,14,3)||lpad(to_hex((get_byte(bytes,8)&63)|128),2,'0')||substr(hex,19,14))::uuid
  FROM encoded;
$$;
REVOKE ALL ON FUNCTION owner_customer_user_identifier(text,uuid,uuid) FROM PUBLIC;

-- Match the domain's fixed JSON key order, rather than relying on jsonb order.
CREATE FUNCTION owner_customer_handoff_operation_hash(value public.owner_customer_handoffs) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to('{"operation":"owner.customer_access.approve","environment":'||to_json(value.environment)::text
    ||',"securityEpoch":'||to_json(value.security_epoch::text)::text||',"platformSecurityEpoch":'||value.platform_security_epoch::text
    ||',"customerOrigin":'||to_json(value.customer_origin)::text||',"platformOrigin":'||to_json(value.platform_origin)::text
    ||',"flowId":'||to_json(value.id::text)::text||',"operatorId":'||to_json(value.operator_id::text)::text
    ||',"tenantId":'||to_json(value.tenant_id::text)::text||',"role":'||to_json(value.selected_role)::text
    ||',"stateHash":'||to_json(value.state_hash::text)::text||',"browserVerifier":'||to_json(value.browser_verifier::text)::text||'}','UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION owner_customer_handoff_operation_hash(public.owner_customer_handoffs) FROM PUBLIC;

-- Read-only private invariant, callable only by the exact trigger parents below.
CREATE FUNCTION assert_owner_customer_handoff(value public.owner_customer_handoffs) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF pg_trigger_depth()<>1 THEN RAISE EXCEPTION 'OWNER_HANDOFF_TRIGGER_CONTEXT_REQUIRED' USING ERRCODE='42501'; END IF;
  IF value.operation_hash IS DISTINCT FROM public.owner_customer_handoff_operation_hash(value)
    OR value.user_id IS DISTINCT FROM public.owner_customer_user_identifier(value.environment,value.tenant_id,value.operator_id) THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_DIGEST_OR_OWN_IDENTITY_INVALID' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.tenant_runtime_registry registry
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=registry.environment
      AND deployment.security_epoch=value.security_epoch
    JOIN public.tenants tenant ON tenant.id=registry.tenant_id
    JOIN public.platform_operators actor ON actor.id=value.operator_id
    JOIN public.platform_owner_customer_users own ON own.environment=value.environment AND own.operator_id=actor.id
      AND own.tenant_id=tenant.id AND own.user_id=value.user_id
      AND own.provider_tenant_reference::text=actor.provider_tenant_reference
      AND own.provider_subject_reference::text=actor.provider_subject_reference
    JOIN public.users person ON person.tenant_id=tenant.id AND person.id=own.user_id
    JOIN public.user_identity_bindings identity ON identity.tenant_id=tenant.id AND identity.user_id=person.id
      AND identity.provider='platform_owner' AND identity.provider_tenant_reference=actor.provider_tenant_reference
      AND identity.provider_user_reference=actor.provider_subject_reference
    JOIN public.platform_audit_events bootstrap ON bootstrap.target_type='platform_operator_bootstrap'
      AND bootstrap.target_id=actor.id::text AND bootstrap.operator_id IS NULL
      AND bootstrap.action='platform.operator.changed' AND bootstrap.assurance_level='offline_owner'
      AND bootstrap.outcome='success' AND bootstrap.retention_class='recovery'
      AND bootstrap.metadata->>'operation'='first_owner_bootstrap' AND bootstrap.metadata->>'environment'=value.environment
    JOIN public.platform_audit_events owner_roles ON owner_roles.target_type='platform_owner_roles'
      AND owner_roles.target_id=actor.id::text AND owner_roles.operator_id IS NULL
      AND owner_roles.action='platform.operator.changed' AND owner_roles.assurance_level='offline_owner'
      AND owner_roles.outcome='success' AND owner_roles.retention_class='recovery'
      AND owner_roles.metadata->>'operation'='owner_all_platform_roles' AND owner_roles.metadata->>'environment'=value.environment
    JOIN public.platform_sessions source ON source.id=value.source_platform_session_id AND source.operator_id=actor.id
    JOIN public.platform_microsoft_operation_proofs proof ON proof.id=value.approval_microsoft_proof_id AND proof.operator_id=actor.id
    JOIN public.platform_audit_events evidence ON evidence.sequence=value.approval_audit_sequence AND evidence.operator_id=actor.id
    WHERE registry.environment=value.environment AND registry.tenant_id=value.tenant_id AND registry.mode='real'
      AND actor.provider='microsoft_entra_platform' AND actor.status='active' AND actor.security_version=value.operator_security_version
      AND actor.scope_mode='all' AND actor.roles=ARRAY[
        'platform_security_admin','platform_security_auditor','platform_support_reader','platform_tenant_operator']::text[]
      AND (SELECT count(*) FROM public.platform_audit_events WHERE target_type='platform_operator_bootstrap')=1
      AND (SELECT count(*) FROM public.platform_audit_events WHERE target_type='platform_owner_roles')=1
      AND tenant.status IN ('pending','onboarding','ready','active') AND person.active=true AND person.security_version=value.user_security_version
      AND NOT EXISTS(SELECT 1 FROM public.tenant_user_roles elevation WHERE elevation.tenant_id=person.tenant_id AND elevation.user_id=person.id)
      AND source.provider=actor.provider AND source.provider_tenant_reference=actor.provider_tenant_reference
      AND source.provider_subject_reference=actor.provider_subject_reference AND source.principal_version=actor.security_version
      AND source.roles=actor.roles AND source.scope_mode=actor.scope_mode AND source.permissions=public.platform_permissions_for_roles(actor.roles)
      AND source.assurance_level='mfa' AND source.authentication_context='cm:ms:mfa:v1' AND source.step_up_expires_at IS NULL
      AND source.security_epoch=value.platform_security_epoch AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp()
      AND source.issued_at<=clock_timestamp()+interval '1 minute'
      AND proof.environment=value.environment AND proof.protected_security_epoch=value.security_epoch
      AND proof.security_epoch=value.platform_security_epoch AND proof.operator_security_version=value.operator_security_version
      AND proof.execution_scope='shared' AND proof.status='consumed' AND proof.operation_hash=value.operation_hash
      AND proof.provider_tenant_reference::text=actor.provider_tenant_reference
      AND proof.provider_subject_reference::text=actor.provider_subject_reference AND proof.expected_session_id<>source.id
      AND proof.consumed_at IS NOT NULL AND proof.consumed_at<proof.expires_at AND proof.authenticated_at=source.authenticated_at
      AND value.approved_at>=date_trunc('milliseconds',proof.consumed_at)
      AND value.approved_at<=date_trunc('milliseconds',proof.consumed_at)+interval '30 seconds'
      AND evidence.action='platform.owner_customer_access.approved' AND evidence.target_tenant_id=tenant.id
      AND evidence.target_type='owner_customer_access' AND evidence.target_id=tenant.id::text
      AND evidence.outcome='success' AND evidence.assurance_level='step_up' AND evidence.roles=actor.roles
      AND evidence.permissions=source.permissions AND evidence.metadata=jsonb_build_object('mode','real','role',value.selected_role,
        'userId',person.id::text,'ownIdentityCreated',value.identity_created,'flowId',value.id::text)
      AND (NOT value.identity_created OR (own.created_flow_id=value.id AND own.created_at=value.approved_at
        AND own.created_proof_id=value.approval_microsoft_proof_id AND own.created_audit_sequence=value.approval_audit_sequence
        AND own.created_operation_hash=value.operation_hash AND person.created_at=own.created_at AND identity.created_at=own.created_at))
    FOR SHARE OF deployment,actor,tenant,person,source,proof,own;
  IF NOT FOUND THEN RAISE EXCEPTION 'OWNER_HANDOFF_APPROVAL_DENIED' USING ERRCODE='23514'; END IF;
END $$;
REVOKE ALL ON FUNCTION assert_owner_customer_handoff(public.owner_customer_handoffs) FROM PUBLIC;

-- Narrow read-lock ports for the Customer credential. They return no identity,
-- proof, session or grant, and current complete custody must be checked both
-- before and after them by the owning repository within the same transaction.
CREATE FUNCTION protected_lock_owner_handoff_source(scope_environment text,scope_epoch uuid,flow_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_id uuid;actor_version bigint;source_id uuid;integer_epoch bigint;
BEGIN
  IF scope_environment IS NULL OR scope_environment NOT IN ('dev','int','prod') OR scope_epoch IS NULL OR flow_id IS NULL
    OR (session_user::text<>('cm_protected_'||scope_environment||'_customer') AND session_user::text<>current_user::text)
    OR NOT pg_try_advisory_xact_lock_shared(740193,CASE scope_environment WHEN 'dev' THEN 1 WHEN 'int' THEN 2 ELSE 3 END) THEN
    RETURN false; END IF;
  SELECT custody.operator_id,custody.operator_security_version,custody.source_platform_session_id,custody.platform_security_epoch
    INTO actor_id,actor_version,source_id,integer_epoch FROM public.owner_customer_handoffs custody
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=custody.environment
      AND deployment.security_epoch=custody.security_epoch
    WHERE custody.environment=scope_environment AND custody.security_epoch=scope_epoch AND custody.id=flow_id AND custody.status='approved';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.platform_operators WHERE id=actor_id AND security_version=actor_version
    AND provider='microsoft_entra_platform' AND status='active' AND scope_mode='all' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.platform_sessions WHERE id=source_id AND operator_id=actor_id AND principal_version=actor_version
    AND security_epoch=integer_epoch AND revoked_at IS NULL AND expires_at>clock_timestamp()
    AND assurance_level='mfa' AND authentication_context='cm:ms:mfa:v1' AND step_up_expires_at IS NULL FOR SHARE NOWAIT;
  RETURN FOUND;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION protected_lock_owner_handoff_source(text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION protected_lock_owner_customer_source(scope_environment text,scope_epoch uuid,customer_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_id uuid;actor_version bigint;source_id uuid;integer_epoch bigint;person_id uuid;person_version bigint;tenant uuid;
BEGIN
  IF scope_environment IS NULL OR scope_environment NOT IN ('dev','int','prod') OR scope_epoch IS NULL OR customer_session IS NULL
    OR (session_user::text<>('cm_protected_'||scope_environment||'_customer') AND session_user::text<>current_user::text)
    OR NOT pg_try_advisory_xact_lock_shared(740193,CASE scope_environment WHEN 'dev' THEN 1 WHEN 'int' THEN 2 ELSE 3 END) THEN
    RETURN false; END IF;
  SELECT custody.operator_id,custody.operator_security_version,custody.source_platform_session_id,custody.platform_security_epoch,
    custody.user_id,custody.user_security_version,custody.tenant_id
    INTO actor_id,actor_version,source_id,integer_epoch,person_id,person_version,tenant FROM public.owner_customer_handoffs custody
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=custody.environment
      AND deployment.security_epoch=custody.security_epoch
    WHERE custody.environment=scope_environment AND custody.security_epoch=scope_epoch
      AND custody.customer_session_id=customer_session AND custody.status='consumed';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.platform_operators WHERE id=actor_id AND security_version=actor_version
    AND provider='microsoft_entra_platform' AND status='active' AND scope_mode='all' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.platform_sessions WHERE id=source_id AND operator_id=actor_id AND principal_version=actor_version
    AND security_epoch=integer_epoch AND revoked_at IS NULL AND expires_at>clock_timestamp()
    AND assurance_level='mfa' AND authentication_context='cm:ms:mfa:v1' AND step_up_expires_at IS NULL FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Final Customer writes acquire target ownership before User/session and
  -- business locks. Direct UPDATE avoids a concurrent SHARE-to-UPDATE upgrade.
  PERFORM id FROM public.tenants WHERE id=tenant AND status IN ('pending','onboarding','ready','active') FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.users WHERE tenant_id=tenant AND id=person_id AND active=true AND security_version=person_version FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM public.sessions WHERE id=customer_session AND tenant_id=tenant AND user_id=person_id
    AND principal_version=person_version AND provider='platform_owner' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE NOWAIT;
  RETURN FOUND;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION protected_lock_owner_customer_source(text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION guard_owner_customer_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope integer;
BEGIN
  IF TG_RELID<>'public.owner_customer_handoffs'::regclass OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
    OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status='consumed' AND EXISTS(SELECT 1 FROM public.sessions session WHERE session.id=OLD.customer_session_id
      AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'OWNER_HANDOFF_ACTIVE_SESSION_REQUIRES_CUSTODY' USING ERRCODE='55000'; END IF;
    IF (OLD.status<>'consumed' AND OLD.expires_at>=clock_timestamp())
      OR (OLD.status='consumed' AND OLD.consumed_at>=clock_timestamp()-interval '24 hours') THEN
      RAISE EXCEPTION 'OWNER_HANDOFF_RETENTION_REQUIRED' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  scope:=CASE NEW.environment WHEN 'dev' THEN 1 WHEN 'int' THEN 2 WHEN 'prod' THEN 3 ELSE NULL END;
  IF scope IS NULL OR NOT pg_try_advisory_xact_lock_shared(740193,scope) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_BUSY' USING ERRCODE='55P03'; END IF;
  PERFORM 1 FROM public.protected_runtime_deployments WHERE environment=NEW.environment
    AND security_epoch=NEW.security_epoch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OWNER_HANDOFF_EPOCH_STALE' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' THEN
      RAISE EXCEPTION 'OWNER_HANDOFF_START_REQUIRED' USING ERRCODE='23514'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('owner-handoff-start-v1'),hashtext(NEW.environment)) THEN
      RAISE EXCEPTION 'OWNER_HANDOFF_START_BUSY' USING ERRCODE='55P03'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.environment,NEW.id,NEW.global_slot,NEW.security_epoch,NEW.platform_security_epoch,NEW.customer_origin,NEW.platform_origin,
      NEW.state_hash,NEW.browser_verifier,NEW.source_key_hash,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.environment,OLD.id,OLD.global_slot,OLD.security_epoch,OLD.platform_security_epoch,OLD.customer_origin,OLD.platform_origin,
      OLD.state_hash,OLD.browser_verifier,OLD.source_key_hash,OLD.created_at,OLD.expires_at)
    OR NOT ((OLD.status='pending' AND NEW.status='approved') OR (OLD.status='approved' AND NEW.status='consumed')) THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  IF OLD.status='pending' THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('owner-customer-approval-v1'),hashtext(NEW.environment||':'||NEW.operator_id::text)) THEN
      RAISE EXCEPTION 'OWNER_HANDOFF_APPROVAL_BUSY' USING ERRCODE='55P03'; END IF;
    IF NEW.approved_at<clock_timestamp()-interval '30 seconds' OR NEW.approved_at>clock_timestamp()+interval '1 second' THEN
      RAISE EXCEPTION 'OWNER_HANDOFF_APPROVAL_CAPACITY_OR_TIME_INVALID' USING ERRCODE='23514'; END IF;
  ELSIF (NEW.owner_slot,NEW.operator_id,NEW.operator_security_version,NEW.selected_role,NEW.tenant_id,NEW.user_id,
      NEW.user_security_version,NEW.identity_created,NEW.source_platform_session_id,NEW.approval_microsoft_proof_id,NEW.operation_hash,NEW.approval_audit_sequence,
      NEW.code_verifier,NEW.approved_at,NEW.code_expires_at)
    IS DISTINCT FROM (OLD.owner_slot,OLD.operator_id,OLD.operator_security_version,OLD.selected_role,OLD.tenant_id,OLD.user_id,
      OLD.user_security_version,OLD.identity_created,OLD.source_platform_session_id,OLD.approval_microsoft_proof_id,OLD.operation_hash,OLD.approval_audit_sequence,
      OLD.code_verifier,OLD.approved_at,OLD.code_expires_at) THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_APPROVAL_IMMUTABLE' USING ERRCODE='23514'; END IF;
  PERFORM public.assert_owner_customer_handoff(NEW);
  RETURN NEW;
END $$;

CREATE FUNCTION guard_owner_handoff_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE custody public.owner_customer_handoffs%ROWTYPE;expected_roles text[];
BEGIN
  IF TG_RELID<>'public.sessions'::regclass OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
    OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_SESSION_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND OLD.provider='platform_owner'
    AND (NEW.id,NEW.tenant_id,NEW.user_id,NEW.provider,NEW.provider_identity_reference,NEW.token_hash,NEW.roles,NEW.permissions,
      NEW.principal_version,NEW.issued_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.user_id,OLD.provider,OLD.provider_identity_reference,OLD.token_hash,OLD.roles,OLD.permissions,
      OLD.principal_version,OLD.issued_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_SESSION_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.provider<>'platform_owner' OR NEW.revoked_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
  SELECT * INTO custody FROM public.owner_customer_handoffs WHERE customer_session_id=NEW.id AND status='consumed';
  IF NOT FOUND OR custody.tenant_id<>NEW.tenant_id OR custody.user_id<>NEW.user_id
    OR custody.user_security_version<>NEW.principal_version
    OR NEW.provider_identity_reference<>custody.id::text||':'||custody.operator_id::text||':'||custody.selected_role
    OR NEW.issued_at<custody.approved_at-interval '1 minute' OR NEW.issued_at>custody.consumed_at+interval '1 minute' THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_SESSION_CUSTODY_REQUIRED' USING ERRCODE='23514'; END IF;
  expected_roles:=CASE WHEN custody.selected_role='employee' THEN ARRAY['employee'] ELSE ARRAY['employee',custody.selected_role] END;
  IF NOT (NEW.roles @> expected_roles AND NEW.roles <@ expected_roles AND cardinality(NEW.roles)=cardinality(expected_roles)) THEN
    RAISE EXCEPTION 'OWNER_HANDOFF_SESSION_ROLE_INVALID' USING ERRCODE='23514'; END IF;
  PERFORM public.assert_owner_customer_handoff(custody);
  RETURN NEW;
END $$;


REVOKE ALL ON FUNCTION guard_owner_customer_handoff() FROM PUBLIC;
CREATE TRIGGER owner_customer_handoff_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_customer_handoffs
  FOR EACH ROW EXECUTE FUNCTION guard_owner_customer_handoff();
REVOKE ALL ON FUNCTION guard_owner_handoff_session() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER owner_handoff_session_custody AFTER INSERT OR UPDATE ON sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_owner_handoff_session();

CREATE FUNCTION guard_platform_owner_customer_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE custody public.owner_customer_handoffs%ROWTYPE;
BEGIN
  IF TG_RELID<>'public.platform_owner_customer_users'::regclass OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
    OR TG_OP<>'INSERT' OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'OWNER_CUSTOMER_IDENTITY_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  SELECT * INTO custody FROM public.owner_customer_handoffs
    WHERE environment=NEW.environment AND id=NEW.created_flow_id AND status IN ('approved','consumed') AND identity_created=true;
  IF NOT FOUND OR custody.operator_id<>NEW.operator_id OR custody.tenant_id<>NEW.tenant_id OR custody.user_id<>NEW.user_id
    OR custody.approved_at<>NEW.created_at OR custody.approval_microsoft_proof_id<>NEW.created_proof_id
    OR custody.approval_audit_sequence<>NEW.created_audit_sequence OR custody.operation_hash<>NEW.created_operation_hash THEN
    RAISE EXCEPTION 'OWNER_CUSTOMER_IDENTITY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514'; END IF;
  PERFORM public.assert_owner_customer_handoff(custody);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_platform_owner_customer_user() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER owner_customer_identity_custody AFTER INSERT ON platform_owner_customer_users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_platform_owner_customer_user();

CREATE FUNCTION guard_owner_customer_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_NARGS<>0 OR pg_trigger_depth()<>1 OR TG_WHEN<>'BEFORE' THEN
    RAISE EXCEPTION 'OWNER_CUSTOMER_HISTORY_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_LEVEL='ROW' AND TG_RELID='public.platform_owner_customer_users'::regclass AND TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'OWNER_CUSTOMER_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_LEVEL<>'STATEMENT' OR TG_OP<>'TRUNCATE' THEN
    RAISE EXCEPTION 'OWNER_CUSTOMER_HISTORY_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_RELID='public.owner_customer_handoffs'::regclass THEN
    IF EXISTS(SELECT 1 FROM public.owner_customer_handoffs LIMIT 1) THEN
      RAISE EXCEPTION 'OWNER_CUSTOMER_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  ELSIF TG_RELID='public.owner_handoff_start_budgets'::regclass THEN
    IF EXISTS(SELECT 1 FROM public.owner_handoff_start_budgets LIMIT 1) THEN
      RAISE EXCEPTION 'OWNER_CUSTOMER_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  ELSIF TG_RELID='public.platform_owner_customer_users'::regclass THEN
    IF EXISTS(SELECT 1 FROM public.platform_owner_customer_users LIMIT 1) THEN
      RAISE EXCEPTION 'OWNER_CUSTOMER_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  ELSE RAISE EXCEPTION 'OWNER_CUSTOMER_HISTORY_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_owner_customer_history() FROM PUBLIC;
CREATE TRIGGER owner_customer_identity_immutable BEFORE UPDATE OR DELETE ON platform_owner_customer_users
  FOR EACH ROW EXECUTE FUNCTION guard_owner_customer_history();
CREATE TRIGGER owner_customer_handoff_truncate BEFORE TRUNCATE ON owner_customer_handoffs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_owner_customer_history();
CREATE TRIGGER owner_handoff_budget_truncate BEFORE TRUNCATE ON owner_handoff_start_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION guard_owner_customer_history();
CREATE TRIGGER owner_customer_identity_truncate BEFORE TRUNCATE ON platform_owner_customer_users
  FOR EACH STATEMENT EXECUTE FUNCTION guard_owner_customer_history();

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
    'platform.synthetic_access.approved',
    'platform.owner_customer_access.approved'
  ));
