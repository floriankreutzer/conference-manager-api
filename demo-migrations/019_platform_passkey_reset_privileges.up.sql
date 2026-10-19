DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.platform_passkey_credentials, public.platform_passkey_auth_transactions FROM %I, %I, %I',
    customer_role, platform_role, reset_role);
  EXECUTE format('GRANT TRUNCATE ON TABLE public.platform_passkey_credentials, public.platform_passkey_auth_transactions TO %I', reset_role);
END $$;
