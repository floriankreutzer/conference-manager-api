DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE INSERT, DELETE ON TABLE public.demo_catalogue_media_assets FROM %I', customer_role);
  EXECUTE format('REVOKE DELETE ON TABLE public.demo_catalogue_media_assets FROM %I', reset_role);
END;
$$;
