LOCK TABLE tenant_user_roles,tenant_microsoft_role_settings,customer_microsoft_group_observations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM tenant_user_roles WHERE cardinality(microsoft_group_ids)>0)
    OR EXISTS(SELECT 1 FROM tenant_microsoft_role_settings)
    OR EXISTS(SELECT 1 FROM customer_microsoft_group_observations) THEN
    RAISE EXCEPTION 'MICROSOFT_GROUP_AUTHORITY_DOWNGRADE_DENIED' USING ERRCODE='55000';
  END IF;
END $$;
DROP TABLE customer_microsoft_group_observations;
DROP FUNCTION guard_customer_microsoft_group_observation();
DROP TABLE tenant_microsoft_role_settings;
DROP FUNCTION tenant_microsoft_role_mappings_valid(jsonb);
DROP FUNCTION tenant_role_source_active(boolean,timestamptz);
DROP TRIGGER tenant_group_role_refresh ON tenant_user_roles;
DROP FUNCTION invalidate_tenant_group_role_refresh();
ALTER TABLE tenant_user_roles DROP CONSTRAINT tenant_role_group_expiry_valid,DROP COLUMN microsoft_verified_until;
