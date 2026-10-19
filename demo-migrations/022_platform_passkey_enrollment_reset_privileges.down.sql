DO $$
DECLARE
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE TRUNCATE ON TABLE public.platform_passkey_enrollment_grants, public.platform_passkey_enrollment_transactions FROM %I', reset_role);
END $$;
