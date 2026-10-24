DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  -- Both tables must stay empty in closed Demo. Canonical read-only trigger
  -- guards reject populated state; no Demo CRUD/SELECT or execution is granted.
  EXECUTE format('GRANT TRUNCATE ON TABLE public.tenant_microsoft_role_settings,
    public.customer_microsoft_group_observations TO %I',reset_role);
END $$;
