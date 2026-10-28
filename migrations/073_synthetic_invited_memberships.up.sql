-- Additive binding only: no existing membership, User, invitation or session is
-- classified or activated. A replacement generation never inherits this row.
ALTER TABLE tenant_runtime_registry ADD CONSTRAINT tenant_runtime_participant_binding_key
  UNIQUE(environment,tenant_id,generation_id,operator_id,slot);
ALTER TABLE customer_member_invitations ADD CONSTRAINT customer_invitation_member_origin_key
  UNIQUE(environment,tenant_id,id,membership_id);

CREATE TABLE synthetic_invited_memberships (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int')),
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  slot varchar(16) NOT NULL CHECK(slot IN ('northwind','contoso','fabrikam')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,tenant_id,membership_id),UNIQUE(environment,membership_id),
  FOREIGN KEY(environment,tenant_id,membership_id)
    REFERENCES customer_access_memberships(environment,tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,tenant_id,invitation_id,membership_id)
    REFERENCES customer_member_invitations(environment,tenant_id,id,membership_id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,tenant_id,generation_id,operator_id,slot)
    REFERENCES tenant_runtime_registry(environment,tenant_id,generation_id,operator_id,slot) ON DELETE RESTRICT
);

CREATE FUNCTION guard_synthetic_invited_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'public.synthetic_invited_memberships'::regclass OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
    OR TG_NARGS<>0 OR pg_trigger_depth()<>1 OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_BINDING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NEW.environment NOT IN ('dev','int')
    OR (session_user::text<>('cm_protected_'||NEW.environment||'_platform') AND session_user::text<>current_user::text)
    OR NOT pg_try_advisory_xact_lock_shared(740193,CASE NEW.environment WHEN 'dev' THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_REGISTRATION_DENIED' USING ERRCODE='23514'; END IF;
  PERFORM registry.tenant_id FROM public.tenant_runtime_registry registry
      JOIN public.synthetic_tenant_generations generation ON generation.environment=registry.environment
        AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
      JOIN public.protected_runtime_deployments deployment ON deployment.environment=generation.environment
        AND deployment.security_epoch=generation.security_epoch
      JOIN public.platform_operators actor ON actor.id=generation.operator_id
        AND actor.security_version=generation.operator_security_version
      JOIN public.tenants tenant ON tenant.id=registry.tenant_id
      JOIN public.customer_access_memberships member ON member.environment=registry.environment
        AND member.tenant_id=registry.tenant_id AND member.id=NEW.membership_id
      JOIN public.customer_member_invitations invitation ON invitation.environment=member.environment
        AND invitation.tenant_id=member.tenant_id AND invitation.membership_id=member.id
        AND invitation.id=NEW.invitation_id
      WHERE registry.environment=NEW.environment AND registry.tenant_id=NEW.tenant_id AND registry.mode='synthetic'
        AND registry.generation_id=NEW.generation_id AND registry.operator_id=NEW.operator_id AND registry.slot=NEW.slot
        AND generation.state='active' AND actor.provider='microsoft_entra_platform' AND actor.status='active'
        AND tenant.status IN ('pending','onboarding','ready','active')
        AND member.user_id IS NULL AND member.accepted_at IS NULL
        AND invitation.revision=1 AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
        AND invitation.expires_at>clock_timestamp() AND invitation.issued_at=invitation.created_at
        AND NEW.created_at>=member.created_at AND NEW.created_at<=clock_timestamp()+interval '1 second'
      FOR SHARE OF deployment,actor,tenant,member,invitation NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_REGISTRATION_DENIED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_REGISTRATION_DENIED' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_invited_membership() FROM PUBLIC;
CREATE TRIGGER synthetic_invited_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON synthetic_invited_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_synthetic_invited_membership();

CREATE FUNCTION guard_synthetic_invited_membership_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'public.synthetic_invited_memberships'::regclass OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT'
    OR TG_NARGS<>0 OR pg_trigger_depth()<>1 OR TG_OP<>'TRUNCATE' THEN
    RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.synthetic_invited_memberships LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_invited_membership_history() FROM PUBLIC;
CREATE TRIGGER synthetic_invited_membership_history_guard BEFORE TRUNCATE ON synthetic_invited_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION guard_synthetic_invited_membership_history();

-- Narrow eligibility/locking port. It grants neither mailbox proof nor a User,
-- role, session or provider capability. Canonical admission/delivery still checks
-- the exact invitation/member and current identity/session/role state afterwards.
CREATE FUNCTION protected_lock_synthetic_participant_scope(scope_environment text,scope_epoch uuid,
  target_tenant uuid,target_member uuid,target_invitation uuid,admission boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_id uuid;actor_version bigint;
BEGIN
  IF scope_environment IS NULL OR scope_environment NOT IN ('dev','int') OR scope_epoch IS NULL OR target_tenant IS NULL
    OR admission IS NULL OR (target_member IS NULL)=(target_invitation IS NULL)
    OR (session_user::text<>('cm_protected_'||scope_environment||'_customer') AND session_user::text<>current_user::text)
    OR NOT pg_try_advisory_xact_lock_shared(740193,CASE scope_environment WHEN 'dev' THEN 1 ELSE 2 END) THEN RETURN false; END IF;
  -- The fixed definer can retain this row lock without granting the Customer
  -- role general deployment UPDATE rights; an older RR snapshot cannot qualify
  -- an epoch that rotated before this function acquired its shared barrier.
  PERFORM environment FROM public.protected_runtime_deployments
    WHERE environment=scope_environment AND security_epoch=scope_epoch FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT generation.operator_id,generation.operator_security_version INTO actor_id,actor_version
    FROM public.synthetic_invited_memberships participant
    JOIN public.tenant_runtime_registry registry ON registry.environment=participant.environment
      AND registry.tenant_id=participant.tenant_id AND registry.generation_id=participant.generation_id
      AND registry.operator_id=participant.operator_id AND registry.slot=participant.slot AND registry.mode='synthetic'
    JOIN public.synthetic_tenant_generations generation ON generation.environment=registry.environment
      AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=generation.environment
      AND deployment.security_epoch=generation.security_epoch
    WHERE participant.environment=scope_environment AND participant.tenant_id=target_tenant
      AND generation.security_epoch=scope_epoch AND generation.state='active'
      AND (participant.membership_id=target_member OR (target_invitation IS NOT NULL AND EXISTS(
        SELECT 1 FROM public.customer_member_invitations invitation WHERE invitation.environment=participant.environment
          AND invitation.tenant_id=participant.tenant_id AND invitation.membership_id=participant.membership_id
          AND invitation.id=target_invitation)));
  IF NOT FOUND THEN RETURN false; END IF;
  -- Independent invited humans require a current enabled generation owner, not
  -- the owner's continuously live delegated Platform session. NOWAIT avoids a
  -- Tenant/actor lock upgrade cycle; contention fails closed, never retries.
  PERFORM id FROM public.platform_operators WHERE id=actor_id AND security_version=actor_version
    AND provider='microsoft_entra_platform' AND status='active' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  IF admission THEN
    PERFORM id FROM public.tenants WHERE id=target_tenant AND status IN ('pending','onboarding','ready','active') FOR UPDATE NOWAIT;
  ELSE
    PERFORM id FROM public.tenants WHERE id=target_tenant AND status IN ('pending','onboarding','ready','active') FOR SHARE NOWAIT;
  END IF;
  RETURN FOUND;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION protected_lock_synthetic_participant_scope(text,uuid,uuid,uuid,uuid,boolean) FROM PUBLIC;
