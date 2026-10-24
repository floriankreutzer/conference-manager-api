LOCK TABLE platform_microsoft_operation_proofs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM platform_microsoft_operation_proofs)
    OR EXISTS(SELECT 1 FROM platform_audit_events WHERE target_type='platform_microsoft_operation') THEN
    RAISE EXCEPTION 'PLATFORM_MICROSOFT_PROOF_DOWNGRADE_REQUIRES_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TRIGGER platform_microsoft_operation_proof_guard ON platform_microsoft_operation_proofs;
DROP TRIGGER platform_microsoft_proofs_empty_reset_guard ON platform_microsoft_operation_proofs;
DROP FUNCTION guard_empty_platform_microsoft_proofs_truncate();
DROP FUNCTION guard_platform_microsoft_operation_proof();
DROP FUNCTION assert_platform_microsoft_operation_source(public.platform_microsoft_operation_proofs);
DROP TABLE platform_microsoft_operation_proofs;
