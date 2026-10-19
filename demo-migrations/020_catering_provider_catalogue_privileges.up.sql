DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_provider_catalogue_revisions,public.catering_provider_catalogue_heads FROM %I,%I,%I',
    customer_role,platform_role,reset_role);
  EXECUTE format('GRANT SELECT,INSERT ON TABLE public.catering_provider_catalogue_revisions TO %I',customer_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.catering_provider_catalogue_heads TO %I',customer_role);
  EXECUTE format('GRANT SELECT,TRUNCATE ON TABLE public.catering_provider_catalogue_revisions,public.catering_provider_catalogue_heads TO %I',
    reset_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.catering_provider_catalogue_text_valid(jsonb,integer,boolean),
    public.catering_provider_catalogue_money_valid(jsonb,boolean),public.catering_provider_catalogue_product_valid(jsonb),
    public.catering_provider_catalogue_document_valid(jsonb),public.guard_catering_provider_catalogue_source(),
    public.guard_catering_provider_catalogue_head(),public.verify_catering_provider_catalogue_source() FROM %I,%I,%I',
    customer_role,platform_role,reset_role);
END $$;
