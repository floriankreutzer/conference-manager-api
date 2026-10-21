-- Private read-lock capability only. It creates no identity/session, writes no
-- Platform row and grants no ordinary Customer caller access to Platform tables.
CREATE FUNCTION protected_lock_synthetic_handoff_source(
  scope_environment text,scope_epoch uuid,flow_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_id uuid;actor_version bigint;source_id uuid;
BEGIN
  -- session_user is the authenticated database principal, unaffected by SET ROLE.
  -- The migration owner can run controlled native/recovery verification; other
  -- callers must use the exact environment-specific Customer credential.
  IF scope_environment IS NULL OR scope_environment NOT IN ('dev','int')
    OR (session_user::text<>('cm_protected_'||scope_environment||'_customer')
      AND session_user::text<>current_user::text) THEN RETURN false; END IF;
  SELECT custody.operator_id,custody.operator_security_version,custody.source_platform_session_id
    INTO actor_id,actor_version,source_id
    FROM public.synthetic_customer_handoffs custody
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=custody.environment
      AND deployment.security_epoch=custody.security_epoch
    WHERE custody.environment=scope_environment AND custody.security_epoch=scope_epoch AND custody.id=flow_id
      AND custody.status='approved';
  IF NOT FOUND THEN RETURN false; END IF;
  -- Preserve the canonical actor -> source-session lock order and RR conflict
  -- behavior. Current full proof/MFA/cookie checks remain with the owning reader
  -- before and after these locks; this boolean never authorizes admission.
  PERFORM actor.id FROM public.platform_operators actor WHERE actor.id=actor_id
    AND actor.security_version=actor_version AND actor.status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM source.id FROM public.platform_sessions source WHERE source.id=source_id
    AND source.operator_id=actor_id AND source.revoked_at IS NULL AND source.expires_at>clock_timestamp() FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION protected_lock_synthetic_handoff_source(text,uuid,uuid) FROM PUBLIC;
-- Defense against pre-existing default privilege settings. No runtime grant is
-- installed here; controlled role bootstrap must grant only the Customer port.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['cm_demo_customer','cm_demo_platform','cm_demo_reset'] LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.protected_lock_synthetic_handoff_source(text,uuid,uuid) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
