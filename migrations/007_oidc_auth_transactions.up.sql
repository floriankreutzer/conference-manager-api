CREATE TABLE oidc_auth_transactions (
  provider varchar(64) NOT NULL,
  state_hash char(64) NOT NULL,
  nonce_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (provider, state_hash),
  CONSTRAINT oidc_auth_transactions_provider_format
    CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT oidc_auth_transactions_state_hash_format
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oidc_auth_transactions_nonce_hash_format
    CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oidc_auth_transactions_expiry_order
    CHECK (expires_at > created_at)
);

CREATE INDEX oidc_auth_transactions_expires_at_idx
  ON oidc_auth_transactions (expires_at);
