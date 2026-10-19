DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_orders,public.catering_order_versions,
    public.catering_order_positions,public.catering_order_version_seals,public.catering_order_heads,
    public.catering_order_quotes,public.catering_order_decisions,public.catering_order_version_states FROM %I,%I,%I',
    customer_role,platform_role,reset_role);
  EXECUTE format('GRANT SELECT,INSERT ON TABLE public.catering_orders,public.catering_order_versions,
    public.catering_order_positions,public.catering_order_quotes,public.catering_order_decisions TO %I',customer_role);
  EXECUTE format('GRANT SELECT ON TABLE public.catering_order_version_seals TO %I',customer_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.catering_order_heads,
    public.catering_order_version_states TO %I',customer_role);
  EXECUTE format('GRANT SELECT,TRUNCATE ON TABLE public.catering_orders,public.catering_order_versions,
    public.catering_order_positions,public.catering_order_version_seals,public.catering_order_heads,
    public.catering_order_quotes,public.catering_order_decisions,public.catering_order_version_states TO %I',reset_role);
END $$;
