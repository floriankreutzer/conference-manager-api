LOCK TABLE tenant_user_roles IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM tenant_user_roles WHERE NOT direct_grant OR cardinality(microsoft_group_ids)>0) THEN
    RAISE EXCEPTION 'CUSTOMER_ROLE_PROVENANCE_REQUIRES_REVIEW' USING ERRCODE='55000';
  END IF;
END $$;
DROP TRIGGER tenant_group_role_session_invalidation ON tenant_user_roles;
DROP FUNCTION invalidate_tenant_group_role_sessions();
ALTER TABLE tenant_user_roles DROP CONSTRAINT tenant_role_has_source,
  DROP CONSTRAINT tenant_role_group_directory_valid,DROP CONSTRAINT tenant_role_group_sources_valid,
  DROP COLUMN microsoft_group_ids,DROP COLUMN microsoft_directory_id,DROP COLUMN direct_grant;
DROP FUNCTION tenant_role_group_sources_valid(uuid[]);
