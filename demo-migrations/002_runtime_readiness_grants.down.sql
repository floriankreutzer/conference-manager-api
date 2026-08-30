DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
BEGIN
  EXECUTE format('REVOKE SELECT ON demo_schema_migrations FROM %I, %I', customer_role, platform_role);
END;
$$;
