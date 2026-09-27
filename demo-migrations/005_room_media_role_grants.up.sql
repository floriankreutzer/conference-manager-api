DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE public.tenant_room_media_assets TO %I',
    customer_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, TRUNCATE ON TABLE public.tenant_room_media_assets TO %I',
    reset_role
  );
END;
$$;
