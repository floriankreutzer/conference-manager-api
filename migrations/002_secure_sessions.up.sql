ALTER TABLE users
  ADD COLUMN security_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT users_security_version_valid CHECK (security_version >= 1);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  provider varchar(64) NOT NULL,
  provider_identity_reference varchar(255) NOT NULL,
  roles text[] NOT NULL,
  permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
  principal_version bigint NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT sessions_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sessions_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_provider_valid CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT sessions_provider_reference_valid CHECK (
    char_length(provider_identity_reference) BETWEEN 1 AND 255
  ),
  CONSTRAINT sessions_roles_count_valid CHECK (cardinality(roles) BETWEEN 1 AND 16),
  CONSTRAINT sessions_roles_no_null CHECK (array_position(roles, NULL) IS NULL),
  CONSTRAINT sessions_permissions_count_valid CHECK (cardinality(permissions) BETWEEN 0 AND 64),
  CONSTRAINT sessions_permissions_no_null CHECK (array_position(permissions, NULL) IS NULL),
  CONSTRAINT sessions_principal_version_valid CHECK (principal_version >= 1),
  CONSTRAINT sessions_expiry_valid CHECK (expires_at > issued_at),
  CONSTRAINT sessions_revocation_time_valid CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX sessions_user_active_idx
  ON sessions (tenant_id, user_id, expires_at)
  WHERE revoked_at IS NULL;
