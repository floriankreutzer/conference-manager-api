DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.platform_projection_outbox FROM %I, %I, %I', customer_role, platform_role, reset_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_projection_outbox TO %I', platform_role);
  EXECUTE format('GRANT SELECT, DELETE, TRUNCATE ON TABLE public.platform_projection_outbox TO %I', reset_role);
END $$;
