DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_order_withdrawals,public.catering_unsent_replacements FROM %I,%I,%I',
    customer_role,platform_role,reset_role);
  EXECUTE format('GRANT SELECT,INSERT ON TABLE public.catering_order_withdrawals,public.catering_unsent_replacements TO %I',customer_role);
  EXECUTE format('GRANT SELECT,TRUNCATE ON TABLE public.catering_order_withdrawals,public.catering_unsent_replacements TO %I',reset_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.catering_order_delivery_operation(uuid,uuid,bigint) TO %I',customer_role);
END $$;
