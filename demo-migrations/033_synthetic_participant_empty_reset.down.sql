DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE TRUNCATE ON TABLE public.synthetic_invited_memberships FROM %I',reset_role);
END $$;
