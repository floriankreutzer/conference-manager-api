DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role', true);
  platform_role text := current_setting('conference_manager.demo_platform_role', true);
  reset_role text := current_setting('conference_manager.demo_reset_role', true);
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[customer_role, platform_role, reset_role]
  LOOP
    IF role_name IS NULL OR role_name !~ '^[a-z][a-z0-9_]{2,62}$' THEN
      RAISE EXCEPTION 'DEMO_DATABASE_ROLE_INVALID' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE EXCEPTION 'DEMO_DATABASE_ROLE_MISSING' USING ERRCODE = '42704';
    END IF;
  END LOOP;
  IF customer_role = platform_role OR customer_role = reset_role OR platform_role = reset_role THEN
    RAISE EXCEPTION 'DEMO_DATABASE_ROLE_ALIAS_FORBIDDEN' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE TABLE demo_database_sentinel (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sentinel_key varchar(64) NOT NULL UNIQUE,
  runtime_schema_version integer NOT NULL CHECK (runtime_schema_version = 1),
  database_name name NOT NULL,
  customer_role name NOT NULL,
  platform_role name NOT NULL,
  reset_role name NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT demo_database_sentinel_roles_distinct CHECK (
    customer_role <> platform_role
    AND customer_role <> reset_role
    AND platform_role <> reset_role
  )
);

INSERT INTO demo_database_sentinel (
  singleton,
  sentinel_key,
  runtime_schema_version,
  database_name,
  customer_role,
  platform_role,
  reset_role
)
VALUES (
  true,
  'conference-manager-shared-demo-v1',
  1,
  current_database(),
  current_setting('conference_manager.demo_customer_role')::name,
  current_setting('conference_manager.demo_platform_role')::name,
  current_setting('conference_manager.demo_reset_role')::name
);

CREATE TABLE demo_provider_simulations (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider varchar(48) NOT NULL,
  connection_state varchar(48) NOT NULL,
  health varchar(48) NOT NULL,
  scenario varchar(48) NOT NULL,
  CONSTRAINT demo_provider_name_valid CHECK (provider ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT demo_provider_connection_valid CHECK (connection_state ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT demo_provider_health_valid CHECK (health ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT demo_provider_scenario_valid CHECK (scenario ~ '^[a-z][a-z0-9_]{1,47}$')
);

CREATE TABLE demo_persona_references (
  surface varchar(16) NOT NULL CHECK (surface IN ('customer', 'platform')),
  context_key varchar(128) PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  persona varchar(32) NOT NULL,
  subject_id uuid NOT NULL,
  provider varchar(32) NOT NULL,
  provider_tenant_reference varchar(160),
  provider_subject_reference varchar(80) NOT NULL,
  assurance_level varchar(16),
  authentication_context varchar(128),
  CONSTRAINT demo_persona_surface_tenant_valid CHECK (
    (surface = 'customer' AND tenant_id IS NOT NULL)
    OR (surface = 'platform' AND tenant_id IS NULL)
  ),
  CONSTRAINT demo_persona_name_valid CHECK (persona ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT demo_persona_provider_valid CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT demo_persona_provider_subject_valid CHECK (
    provider_subject_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$'
  ),
  CONSTRAINT demo_persona_assurance_valid CHECK (
    (surface = 'customer' AND assurance_level IS NULL AND authentication_context IS NULL)
    OR (
      surface = 'platform'
      AND assurance_level IN ('mfa', 'step_up')
      AND authentication_context ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    )
  )
);

CREATE UNIQUE INDEX demo_persona_customer_context_unique
  ON demo_persona_references (tenant_id, persona)
  WHERE surface = 'customer';
CREATE UNIQUE INDEX demo_persona_platform_context_unique
  ON demo_persona_references (persona)
  WHERE surface = 'platform';

CREATE FUNCTION reject_demo_immutable_state_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'DEMO_IMMUTABLE_STATE_MUTATION_FORBIDDEN' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER demo_database_sentinel_immutable
BEFORE UPDATE OR DELETE ON demo_database_sentinel
FOR EACH ROW EXECUTE FUNCTION reject_demo_immutable_state_mutation();
ALTER TABLE demo_database_sentinel ENABLE ALWAYS TRIGGER demo_database_sentinel_immutable;

CREATE TRIGGER demo_provider_simulation_immutable
BEFORE UPDATE OR DELETE ON demo_provider_simulations
FOR EACH ROW EXECUTE FUNCTION reject_demo_immutable_state_mutation();
ALTER TABLE demo_provider_simulations ENABLE ALWAYS TRIGGER demo_provider_simulation_immutable;

CREATE TRIGGER demo_persona_reference_immutable
BEFORE UPDATE OR DELETE ON demo_persona_references
FOR EACH ROW EXECUTE FUNCTION reject_demo_immutable_state_mutation();
ALTER TABLE demo_persona_references ENABLE ALWAYS TRIGGER demo_persona_reference_immutable;

CREATE VIEW demo_customer_persona_references AS
SELECT context_key, tenant_id, persona, subject_id, provider, provider_subject_reference
FROM demo_persona_references
WHERE surface = 'customer';

CREATE VIEW demo_platform_persona_references AS
SELECT context_key, persona, subject_id AS operator_id, provider,
       provider_tenant_reference, provider_subject_reference,
       assurance_level, authentication_context
FROM demo_persona_references
WHERE surface = 'platform';

REVOKE ALL ON demo_database_sentinel FROM PUBLIC;
REVOKE ALL ON demo_provider_simulations FROM PUBLIC;
REVOKE ALL ON demo_persona_references FROM PUBLIC;
REVOKE ALL ON demo_customer_persona_references FROM PUBLIC;
REVOKE ALL ON demo_platform_persona_references FROM PUBLIC;

DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
  reset_table text;
  runtime_table text;
  runtime_sequence text;
  customer_tables text[] := ARRAY[
    'tenants', 'users', 'sites', 'rooms', 'services', 'catering_packages', 'catering_items',
    'integrations', 'requests', 'notifications', 'audit_events', 'sessions', 'tenant_entitlements',
    'booking_provider_references', 'oidc_auth_transactions', 'tenant_onboarding_invitations',
    'tenant_identity_bindings', 'tenant_claim_transactions', 'user_identity_bindings',
    'tenant_user_roles', 'microsoft365_consent_transactions', 'microsoft365_room_mappings',
    'microsoft365_capability_health', 'booking_change_requests', 'tenant_location_revisions',
    'tenant_organization_settings', 'tenant_organization_revisions', 'equipment',
    'catering_package_variants', 'catering_package_items', 'service_site_applicability',
    'service_room_applicability', 'equipment_site_applicability', 'equipment_room_applicability',
    'catering_package_site_applicability', 'catering_package_room_applicability',
    'catering_item_site_applicability', 'catering_item_room_applicability',
    'tenant_catalogue_revisions', 'tenant_booking_policy_configuration',
    'tenant_booking_policy_revisions', 'tenant_cost_allocation_configuration', 'tenant_cost_centers',
    'tenant_cost_allocation_revisions', 'request_v2_migration_state', 'tenant_room_prices',
    'request_revisions', 'tenant_bulk_transfer_receipts'
  ];
  platform_read_tables text[] := ARRAY[
    'tenants', 'users', 'rooms', 'integrations', 'sessions', 'tenant_entitlements',
    'tenant_user_roles', 'booking_provider_references', 'microsoft365_room_mappings',
    'microsoft365_capability_health'
  ];
  platform_write_tables text[] := ARRAY[
    'tenants', 'users', 'sessions', 'tenant_entitlements', 'integrations', 'audit_events',
    'booking_provider_references', 'tenant_onboarding_invitations', 'tenant_identity_bindings',
    'tenant_claim_transactions', 'user_identity_bindings', 'tenant_user_roles',
    'tenant_organization_settings', 'tenant_organization_revisions', 'tenant_catalogue_revisions',
    'tenant_booking_policy_configuration', 'tenant_booking_policy_revisions',
    'tenant_cost_allocation_configuration', 'tenant_cost_allocation_revisions', 'platform_operators',
    'platform_operator_tenant_scopes', 'platform_sessions', 'platform_oidc_auth_transactions',
    'platform_break_glass_grants', 'platform_break_glass_alert_outbox',
    'platform_security_alert_outbox', 'platform_operator_change_alert_outbox',
    'platform_audit_events', 'platform_audit_checkpoints', 'platform_audit_chain_state',
    'platform_operation_receipts', 'platform_entitlement_packages',
    'platform_entitlement_package_revisions', 'platform_entitlement_change_history',
    'platform_tenant_readiness_snapshots', 'platform_tenant_readiness_evidence',
    'platform_microsoft_fleet_snapshots', 'platform_microsoft_fleet_capabilities',
    'microsoft365_room_discovery_observations', 'platform_diagnostic_events',
    'platform_recovery_contexts', 'platform_microsoft_reconsent_handoffs',
    'platform_metering_events', 'platform_metering_periods', 'platform_metering_period_revisions',
    'platform_operational_quotas', 'platform_quota_operation_receipts',
    'platform_runtime_deployments', 'platform_runtime_tenant_mappings'
  ];
  reset_tables text[] := ARRAY[
    'tenants', 'users', 'sites', 'rooms', 'services', 'catering_packages', 'catering_items',
    'integrations', 'requests', 'notifications', 'audit_events', 'sessions', 'tenant_entitlements',
    'booking_provider_references', 'oidc_auth_transactions', 'tenant_onboarding_invitations',
    'tenant_identity_bindings', 'tenant_claim_transactions', 'user_identity_bindings',
    'tenant_user_roles', 'microsoft365_consent_transactions', 'microsoft365_room_mappings',
    'microsoft365_capability_health', 'booking_change_requests', 'tenant_location_revisions',
    'tenant_organization_settings', 'tenant_organization_revisions', 'equipment',
    'catering_package_variants', 'catering_package_items', 'service_site_applicability',
    'service_room_applicability', 'equipment_site_applicability', 'equipment_room_applicability',
    'catering_package_site_applicability', 'catering_package_room_applicability',
    'catering_item_site_applicability', 'catering_item_room_applicability',
    'tenant_catalogue_revisions', 'tenant_booking_policy_configuration',
    'tenant_booking_policy_revisions', 'tenant_cost_allocation_configuration', 'tenant_cost_centers',
    'tenant_cost_allocation_revisions', 'request_v2_migration_state', 'tenant_room_prices',
    'request_revisions', 'tenant_bulk_transfer_receipts', 'platform_operators',
    'platform_operator_tenant_scopes', 'platform_sessions', 'platform_oidc_auth_transactions',
    'platform_break_glass_grants', 'platform_break_glass_alert_outbox',
    'platform_security_alert_outbox', 'platform_operator_change_alert_outbox',
    'platform_audit_events', 'platform_audit_checkpoints', 'platform_audit_chain_state',
    'platform_operation_receipts', 'platform_entitlement_packages',
    'platform_entitlement_package_revisions', 'platform_entitlement_change_history',
    'platform_tenant_readiness_snapshots', 'platform_tenant_readiness_evidence',
    'platform_microsoft_fleet_snapshots', 'platform_microsoft_fleet_capabilities',
    'microsoft365_room_discovery_observations', 'platform_diagnostic_events',
    'platform_recovery_contexts', 'platform_microsoft_reconsent_handoffs',
    'platform_metering_events', 'platform_metering_periods', 'platform_metering_period_revisions',
    'platform_operational_quotas', 'platform_quota_operation_receipts',
    'platform_runtime_deployments', 'platform_runtime_tenant_mappings',
    'demo_provider_simulations', 'demo_persona_references'
  ];
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I, %I', customer_role, platform_role, reset_role);
  EXECUTE format(
    'GRANT SELECT ON demo_database_sentinel, demo_customer_persona_references TO %I',
    customer_role
  );
  EXECUTE format(
    'GRANT SELECT ON demo_database_sentinel, '
    'demo_platform_persona_references, demo_provider_simulations TO %I',
    platform_role
  );
  EXECUTE format('GRANT SELECT ON demo_database_sentinel TO %I', reset_role);
  EXECUTE format('GRANT SELECT ON schema_migrations, demo_schema_migrations TO %I', reset_role);
  FOREACH runtime_table IN ARRAY customer_tables
  LOOP
    IF to_regclass(format('public.%I', runtime_table)) IS NULL THEN
      RAISE EXCEPTION 'DEMO_CUSTOMER_TABLE_MISSING:%', runtime_table USING ERRCODE = '42P01';
    END IF;
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I',
      runtime_table,
      customer_role
    );
    FOR runtime_sequence IN
      SELECT sequence.relname
      FROM pg_class AS sequence
      JOIN pg_depend AS dependency ON dependency.objid = sequence.oid
      WHERE sequence.relkind = 'S'
        AND dependency.refobjid = to_regclass(format('public.%I', runtime_table))
    LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', runtime_sequence, customer_role);
    END LOOP;
  END LOOP;
  FOREACH runtime_table IN ARRAY platform_read_tables
  LOOP
    IF to_regclass(format('public.%I', runtime_table)) IS NULL THEN
      RAISE EXCEPTION 'DEMO_PLATFORM_TABLE_MISSING:%', runtime_table USING ERRCODE = '42P01';
    END IF;
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', runtime_table, platform_role);
  END LOOP;
  FOREACH runtime_table IN ARRAY platform_write_tables
  LOOP
    IF to_regclass(format('public.%I', runtime_table)) IS NULL THEN
      RAISE EXCEPTION 'DEMO_PLATFORM_TABLE_MISSING:%', runtime_table USING ERRCODE = '42P01';
    END IF;
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I',
      runtime_table,
      platform_role
    );
    FOR runtime_sequence IN
      SELECT sequence.relname
      FROM pg_class AS sequence
      JOIN pg_depend AS dependency ON dependency.objid = sequence.oid
      WHERE sequence.relkind = 'S'
        AND dependency.refobjid = to_regclass(format('public.%I', runtime_table))
    LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', runtime_sequence, platform_role);
    END LOOP;
  END LOOP;
  FOREACH reset_table IN ARRAY reset_tables
  LOOP
    IF to_regclass(format('public.%I', reset_table)) IS NULL THEN
      RAISE EXCEPTION 'DEMO_RESET_TABLE_MISSING:%', reset_table USING ERRCODE = '42P01';
    END IF;
    IF reset_table IN ('demo_provider_simulations', 'demo_persona_references') THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, TRUNCATE ON TABLE public.%I TO %I',
        reset_table,
        reset_role
      );
    ELSE
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I TO %I',
        reset_table,
        reset_role
      );
    END IF;
  END LOOP;
  FOR reset_table IN
    SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', reset_table, reset_role);
  END LOOP;
END;
$$;
