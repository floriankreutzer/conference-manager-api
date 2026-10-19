DO $$
DECLARE
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE TRUNCATE ON TABLE public.platform_passkey_credentials, public.platform_passkey_auth_transactions FROM %I', reset_role);
END $$;
