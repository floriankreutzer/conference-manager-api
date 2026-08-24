DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_user_roles LIMIT 1) THEN
    RAISE EXCEPTION 'TENANT_USER_ROLE_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM tenant_identity_bindings
    WHERE claimant_provider_user_reference IS NOT NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'TENANT_ROLE_CLAIMANT_BINDINGS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP INDEX tenant_user_roles_tenant_role_idx;
DROP TABLE tenant_user_roles;

ALTER TABLE tenant_identity_bindings
  DROP CONSTRAINT tenant_identity_bindings_claimant_user_reference_valid,
  DROP COLUMN claimant_provider_user_reference;
