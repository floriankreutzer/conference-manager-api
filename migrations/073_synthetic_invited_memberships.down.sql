DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM synthetic_invited_memberships LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_PARTICIPANT_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP FUNCTION protected_lock_synthetic_participant_scope(text,uuid,uuid,uuid,uuid,boolean);
DROP TABLE synthetic_invited_memberships;
DROP FUNCTION guard_synthetic_invited_membership_history();
DROP FUNCTION guard_synthetic_invited_membership();
ALTER TABLE customer_member_invitations DROP CONSTRAINT customer_invitation_member_origin_key;
ALTER TABLE tenant_runtime_registry DROP CONSTRAINT tenant_runtime_participant_binding_key;
