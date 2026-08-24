ALTER TABLE tenant_identity_bindings
  ADD COLUMN claimant_provider_user_reference varchar(128),
  ADD CONSTRAINT tenant_identity_bindings_claimant_user_reference_valid CHECK (
    claimant_provider_user_reference IS NULL
    OR claimant_provider_user_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  );

CREATE TABLE tenant_user_roles (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, role),
  CONSTRAINT tenant_user_roles_user_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_user_roles_role_valid
    CHECK (role IN ('conference_manager', 'tenant_admin')),
  CONSTRAINT tenant_user_roles_timestamps_valid
    CHECK (updated_at >= created_at)
);

CREATE INDEX tenant_user_roles_tenant_role_idx
  ON tenant_user_roles (tenant_id, role, user_id);
