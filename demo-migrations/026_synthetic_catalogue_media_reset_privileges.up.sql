DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.synthetic_catalogue_media_assets FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT TRUNCATE ON TABLE public.synthetic_catalogue_media_assets TO %I',reset_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.guard_synthetic_catalogue_media(),public.guard_synthetic_catalogue_media_truncate() FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
