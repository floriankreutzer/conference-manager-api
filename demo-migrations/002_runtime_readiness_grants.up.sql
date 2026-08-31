DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
BEGIN
  EXECUTE format('GRANT SELECT ON demo_schema_migrations TO %I, %I', customer_role, platform_role);
END;
$$;
