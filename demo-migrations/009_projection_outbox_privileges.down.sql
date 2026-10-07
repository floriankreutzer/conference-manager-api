DO $$
DECLARE
  platform_role text := current_setting('conference_manager.demo_platform_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.platform_projection_outbox FROM %I, %I', platform_role, reset_role);
END $$;
