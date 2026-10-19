DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_version_proposals FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION public.catering_order_source_current(uuid,uuid,bigint) FROM %I',customer_role);
END $$;
