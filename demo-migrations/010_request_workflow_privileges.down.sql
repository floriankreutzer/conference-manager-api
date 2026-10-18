DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.request_workflow_starts FROM %I, %I', customer_role, reset_role);
END $$;
