DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE TRUNCATE ON TABLE public.tenant_microsoft_role_settings,
    public.customer_microsoft_group_observations FROM %I',reset_role);
END $$;
