DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.catering_catalogue_assignment_heads,
    public.catering_catalogue_assignment_revisions, public.catering_catalogue_assignment_entries,
    public.catering_catalogue_assignment_seals FROM %I, %I',
    customer_role, reset_role);
END $$;
