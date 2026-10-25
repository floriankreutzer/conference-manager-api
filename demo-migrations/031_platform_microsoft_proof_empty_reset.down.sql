DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE TRUNCATE ON TABLE public.platform_microsoft_operation_proofs FROM %I',reset_role);
END $$;
