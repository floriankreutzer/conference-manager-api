DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format(
    'REVOKE SELECT, INSERT ON TABLE public.tenant_room_media_assets FROM %I',
    customer_role
  );
  EXECUTE format(
    'REVOKE SELECT, INSERT, TRUNCATE ON TABLE public.tenant_room_media_assets FROM %I',
    reset_role
  );
END;
$$;
