DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.synthetic_customer_handoffs,public.synthetic_handoff_start_budgets FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT TRUNCATE ON TABLE public.synthetic_customer_handoffs,public.synthetic_handoff_start_budgets TO %I',reset_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.assert_synthetic_handoff_approval(public.synthetic_customer_handoffs),public.guard_synthetic_customer_handoff(),public.guard_synthetic_handoff_session(),public.guard_synthetic_handoff_truncate() FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
