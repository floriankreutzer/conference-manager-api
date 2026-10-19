DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION public.catering_delivery_authority_current(public.catering_delivery_jobs)
    FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('REVOKE ALL ON TABLE public.catering_delivery_jobs,public.catering_delivery_attempts,
    public.catering_delivery_observations FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.catering_delivery_jobs TO %I',customer_role);
  EXECUTE format('GRANT SELECT,INSERT ON TABLE public.catering_delivery_attempts,
    public.catering_delivery_observations TO %I',customer_role);
  EXECUTE format('GRANT SELECT,TRUNCATE ON TABLE public.catering_delivery_jobs,public.catering_delivery_attempts,
    public.catering_delivery_observations TO %I',reset_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.catering_delivery_authority_current(public.catering_delivery_jobs)
    TO %I',customer_role);
END $$;
