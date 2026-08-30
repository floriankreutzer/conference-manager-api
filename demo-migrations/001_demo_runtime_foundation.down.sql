DO $$
BEGIN
  LOCK TABLE demo_database_sentinel IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE demo_provider_simulations IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE demo_persona_references IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM demo_provider_simulations)
    OR EXISTS (SELECT 1 FROM demo_persona_references) THEN
    RAISE EXCEPTION 'DEMO_RUNTIME_FOUNDATION_IN_USE' USING ERRCODE = '55000';
  END IF;
END;
$$;

DO $$
DECLARE
  customer_role text;
  platform_role text;
  reset_role text;
BEGIN
  SELECT sentinel.customer_role, sentinel.platform_role, sentinel.reset_role
  INTO customer_role, platform_role, reset_role
  FROM demo_database_sentinel AS sentinel
  WHERE singleton = true;
  IF customer_role IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = customer_role) THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', customer_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', customer_role);
    EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', customer_role);
  END IF;
  IF platform_role IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = platform_role) THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', platform_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', platform_role);
    EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', platform_role);
  END IF;
  IF reset_role IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = reset_role) THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', reset_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', reset_role);
    EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', reset_role);
  END IF;
END;
$$;

DROP VIEW demo_platform_persona_references;
DROP VIEW demo_customer_persona_references;
DROP TABLE demo_persona_references;
DROP TABLE demo_provider_simulations;
DROP TRIGGER demo_database_sentinel_immutable ON demo_database_sentinel;
DROP TABLE demo_database_sentinel;
DROP FUNCTION reject_demo_immutable_state_mutation();
