LOCK TABLE platform_passkey_enrollment_grants, platform_passkey_enrollment_transactions,
  platform_audit_events IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_passkey_enrollment_grants)
    OR EXISTS (SELECT 1 FROM platform_passkey_enrollment_transactions)
    OR EXISTS (SELECT 1 FROM platform_audit_events WHERE assurance_level = 'offline_owner') THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_ENROLLMENT_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE = '55000';
  END IF;
END;
$$;
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_actor_snapshot_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_actor_snapshot_valid CHECK (
  (operator_id IS NULL AND action = 'platform.authentication.failed'
    AND cardinality(roles) = 0 AND cardinality(permissions) = 0 AND assurance_level = 'unverified')
  OR (operator_id IS NOT NULL AND platform_roles_are_canonical(roles)
    AND permissions = platform_permissions_for_roles(roles)
    AND assurance_level IN ('mfa', 'step_up', 'break_glass'))
);
DROP TABLE platform_passkey_enrollment_transactions;
DROP TABLE platform_passkey_enrollment_grants;
DROP FUNCTION protect_platform_passkey_enrollment_transaction();
DROP FUNCTION protect_platform_passkey_enrollment_grant();
DROP FUNCTION authorize_platform_passkey_enrollment_grant();
