DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  -- Empty FK child only. Its private guard refuses all retained authority.
  EXECUTE format('GRANT TRUNCATE ON TABLE public.platform_microsoft_operation_proofs TO %I',reset_role);
END $$;
