-- Additive audit vocabulary only. No operator, session, key or grant is created.
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_actor_snapshot_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_actor_snapshot_valid CHECK (
  (operator_id IS NULL AND cardinality(roles) = 0 AND cardinality(permissions) = 0
    AND ((action = 'platform.authentication.failed' AND assurance_level = 'unverified')
      OR (action = 'platform.operator.changed' AND assurance_level = 'offline_owner'
        AND target_tenant_id IS NULL AND target_type IN ('platform_passkey_grant', 'platform_operator_bootstrap')
        AND retention_class = 'recovery' AND outcome = 'success')))
  OR (operator_id IS NOT NULL AND platform_roles_are_canonical(roles)
    AND permissions = platform_permissions_for_roles(roles)
    AND assurance_level IN ('mfa', 'step_up', 'break_glass'))
);

CREATE FUNCTION guard_platform_owner_bootstrap_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE owner_role text;
BEGIN
  IF NEW.target_type <> 'platform_operator_bootstrap' THEN RETURN NEW; END IF;
  SELECT pg_get_userbyid(relowner) INTO owner_role FROM pg_class
    WHERE oid = 'public.platform_operators'::regclass;
  IF current_user <> owner_role OR session_user <> owner_role
    OR NEW.operator_id IS NOT NULL OR NEW.assurance_level <> 'offline_owner'
    OR NEW.action <> 'platform.operator.changed' OR NEW.target_tenant_id IS NOT NULL
    OR NEW.outcome <> 'success' OR NEW.retention_class <> 'recovery'
    OR NEW.metadata->>'operation' IS DISTINCT FROM 'first_owner_bootstrap'
    OR NEW.metadata->>'environment' IS DISTINCT FROM 'int'
    OR NOT EXISTS (SELECT 1 FROM public.protected_runtime_deployments
      WHERE environment = 'int' AND security_epoch::text = NEW.metadata->>'deploymentEpoch')
    OR EXISTS (SELECT 1 FROM public.platform_audit_events WHERE target_type = 'platform_operator_bootstrap')
    OR (SELECT count(*) FROM public.platform_operators WHERE provider <> 'demo_platform') <> 1
    OR NOT EXISTS (SELECT 1 FROM public.platform_operators
      WHERE id::text = NEW.target_id AND provider = 'microsoft_entra_platform' AND status = 'active'
        AND scope_mode = 'all' AND security_version = 1
        AND roles = ARRAY['platform_security_admin','platform_tenant_operator']::text[]) THEN
    RAISE EXCEPTION 'PLATFORM_OWNER_BOOTSTRAP_AUDIT_REFUSED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_platform_owner_bootstrap_audit() FROM PUBLIC;
CREATE TRIGGER platform_owner_bootstrap_audit_guard BEFORE INSERT ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION guard_platform_owner_bootstrap_audit();
