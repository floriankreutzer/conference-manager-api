LOCK TABLE platform_audit_chain_state IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_audit_checkpoints IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_audit_events IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_audit_events LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_audit_checkpoints LIMIT 1)
     OR EXISTS (
       SELECT 1 FROM platform_audit_chain_state
       WHERE event_count <> 0 OR terminal_event_hash IS NOT NULL OR terminal_checkpoint_hash IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER platform_audit_checkpoints_append_only ON platform_audit_checkpoints;
DROP TRIGGER platform_audit_events_append_only ON platform_audit_events;
DROP FUNCTION reject_platform_audit_mutation();
DROP TABLE platform_audit_chain_state;
DROP TABLE platform_audit_checkpoints;
DROP INDEX platform_audit_correlation_idx;
DROP INDEX platform_audit_tenant_time_idx;
DROP INDEX platform_audit_operator_time_idx;
DROP TABLE platform_audit_events;
