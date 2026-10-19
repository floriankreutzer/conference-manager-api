DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_catalogue_reviews,public.catering_catalogue_review_heads,
    public.catering_catalogue_publication_heads FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT SELECT,INSERT ON TABLE public.catering_catalogue_reviews TO %I',customer_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.catering_catalogue_review_heads,
    public.catering_catalogue_publication_heads TO %I',customer_role);
  EXECUTE format('GRANT SELECT,TRUNCATE ON TABLE public.catering_catalogue_reviews,public.catering_catalogue_review_heads,
    public.catering_catalogue_publication_heads TO %I',reset_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.catering_catalogue_review_mapping_valid(jsonb,boolean,boolean),
    public.catering_catalogue_review_command_valid(jsonb),public.guard_catering_catalogue_review(),
    public.guard_catering_catalogue_review_head(),public.verify_catering_catalogue_review() FROM %I,%I,%I',
    customer_role,platform_role,reset_role);
END $$;
