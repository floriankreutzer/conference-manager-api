DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.request_workflow_starts FROM %I, %I, %I', customer_role, platform_role, reset_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.request_workflow_starts TO %I', customer_role);
  EXECUTE format('GRANT SELECT, TRUNCATE ON TABLE public.request_workflow_starts TO %I', reset_role);
END $$;
