DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.synthetic_calendar_events,public.synthetic_calendar_resources FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT TRUNCATE ON TABLE public.synthetic_calendar_events,public.synthetic_calendar_resources TO %I',reset_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.guard_synthetic_calendar_event(),public.guard_synthetic_calendar_resource(),public.guard_synthetic_calendar_truncate() FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
