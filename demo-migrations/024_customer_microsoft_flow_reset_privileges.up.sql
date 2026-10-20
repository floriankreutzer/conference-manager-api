-- Closed, synthetic-only Demo reset. Protected INT never uses this reset path.
DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.customer_microsoft_flows,public.customer_microsoft_start_budgets FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT TRUNCATE ON TABLE public.customer_microsoft_flows,public.customer_microsoft_start_budgets TO %I',reset_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.customer_microsoft_snapshot_valid(jsonb),public.guard_customer_microsoft_flow(),public.verify_customer_microsoft_link(),public.guard_customer_microsoft_identity_link(),public.guard_customer_microsoft_start_budget() FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
