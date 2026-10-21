DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM synthetic_customer_handoffs LIMIT 1)
    OR EXISTS(SELECT 1 FROM synthetic_handoff_start_budgets LIMIT 1)
    OR EXISTS(SELECT 1 FROM sessions WHERE provider='platform_delegation' LIMIT 1)
    OR EXISTS(SELECT 1 FROM platform_audit_events WHERE action='platform.synthetic_access.approved' LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP FUNCTION protected_lock_synthetic_handoff_source(text,uuid,uuid);
