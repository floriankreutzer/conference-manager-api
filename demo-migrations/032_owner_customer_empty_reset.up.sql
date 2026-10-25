DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  -- Private guards reject retained owner authority/history; empty FK children
  -- must nevertheless participate explicitly in the existing canonical reset.
  EXECUTE format('GRANT TRUNCATE ON TABLE public.owner_customer_handoffs,public.owner_handoff_start_budgets,public.platform_owner_customer_users TO %I',reset_role);
END $$;
