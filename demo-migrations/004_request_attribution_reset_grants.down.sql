DO $$
DECLARE
  configured_reset_role text := current_setting('conference_manager.demo_reset_role', true);
  recorded_reset_role text;
BEGIN
  SELECT sentinel.reset_role::text
  INTO recorded_reset_role
  FROM demo_database_sentinel AS sentinel
  WHERE sentinel.singleton = true;

  IF configured_reset_role IS NULL
    OR configured_reset_role !~ '^[a-z][a-z0-9_]{2,62}$'
    OR recorded_reset_role IS NULL
    OR configured_reset_role <> recorded_reset_role THEN
    RAISE EXCEPTION 'DEMO_DATABASE_RESET_ROLE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = recorded_reset_role) THEN
    RAISE EXCEPTION 'DEMO_DATABASE_ROLE_MISSING' USING ERRCODE = '42704';
  END IF;
  IF to_regclass('public.request_attribution_migration_state') IS NULL THEN
    RAISE EXCEPTION 'DEMO_RESET_TABLE_MISSING:request_attribution_migration_state'
      USING ERRCODE = '42P01';
  END IF;

  EXECUTE format(
    'REVOKE INSERT, TRUNCATE ON TABLE public.request_attribution_migration_state FROM %I',
    recorded_reset_role
  );
END;
$$;
