DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_catalogue_reviews,public.catering_catalogue_review_heads,
    public.catering_catalogue_publication_heads FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
