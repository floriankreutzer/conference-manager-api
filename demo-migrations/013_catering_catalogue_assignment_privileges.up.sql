DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_catalogue_assignment_heads,
    public.catering_catalogue_assignment_revisions, public.catering_catalogue_assignment_entries,
    public.catering_catalogue_assignment_seals FROM %I, %I, %I',
    customer_role, platform_role, reset_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.catering_catalogue_assignment_heads TO %I', customer_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE public.catering_catalogue_assignment_revisions,
    public.catering_catalogue_assignment_entries TO %I', customer_role);
  EXECUTE format('GRANT SELECT ON TABLE public.catering_catalogue_assignment_seals TO %I', customer_role);
  EXECUTE format('GRANT SELECT, TRUNCATE ON TABLE public.catering_catalogue_assignment_heads,
    public.catering_catalogue_assignment_revisions, public.catering_catalogue_assignment_entries,
    public.catering_catalogue_assignment_seals TO %I', reset_role);
END $$;
