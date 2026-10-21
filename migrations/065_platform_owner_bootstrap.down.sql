LOCK TABLE platform_audit_events IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform_audit_events WHERE target_type = 'platform_operator_bootstrap') THEN
    RAISE EXCEPTION 'PLATFORM_OWNER_BOOTSTRAP_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TRIGGER platform_owner_bootstrap_audit_guard ON platform_audit_events;
DROP FUNCTION guard_platform_owner_bootstrap_audit();
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_actor_snapshot_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_actor_snapshot_valid CHECK (
  (operator_id IS NULL AND cardinality(roles) = 0 AND cardinality(permissions) = 0
    AND ((action = 'platform.authentication.failed' AND assurance_level = 'unverified')
      OR (action = 'platform.operator.changed' AND assurance_level = 'offline_owner'
        AND target_tenant_id IS NULL AND target_type = 'platform_passkey_grant'
        AND retention_class = 'recovery' AND outcome = 'success')))
  OR (operator_id IS NOT NULL AND platform_roles_are_canonical(roles)
    AND permissions = platform_permissions_for_roles(roles)
    AND assurance_level IN ('mfa', 'step_up', 'break_glass'))
);
