DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_manual_delivery_facts,public.catering_manual_delivery_heads
    FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT SELECT,INSERT ON TABLE public.catering_manual_delivery_facts TO %I',customer_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.catering_manual_delivery_heads TO %I',customer_role);
  EXECUTE format('GRANT SELECT,TRUNCATE ON TABLE public.catering_manual_delivery_facts,public.catering_manual_delivery_heads
    TO %I',reset_role);
END $$;
