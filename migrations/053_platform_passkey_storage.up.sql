CREATE TABLE platform_passkey_credentials (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  environment VARCHAR(4) NOT NULL CHECK (environment IN ('dev', 'int', 'prod')),
  credential_id VARCHAR(1366) NOT NULL CHECK (credential_id ~ '^[A-Za-z0-9_-]+$'),
  public_key VARCHAR(512) NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]+$'),
  user_handle VARCHAR(43) NOT NULL CHECK (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  signature_counter BIGINT NOT NULL CHECK (signature_counter BETWEEN 0 AND 4294967295),
  backup_eligible BOOLEAN NOT NULL,
  backed_up BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (environment, credential_id),
  CHECK (NOT backed_up OR backup_eligible),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX platform_passkey_operator_active_idx
  ON platform_passkey_credentials (operator_id, environment) WHERE revoked_at IS NULL;

CREATE TABLE platform_passkey_auth_transactions (
  id UUID PRIMARY KEY,
  state_hash CHAR(64) NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash CHAR(64) NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  challenge VARCHAR(43) NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  operator_security_version BIGINT NOT NULL CHECK (operator_security_version >= 1),
  environment VARCHAR(4) NOT NULL CHECK (environment IN ('dev', 'int', 'prod')),
  security_epoch BIGINT NOT NULL CHECK (security_epoch >= 1),
  purpose VARCHAR(16) NOT NULL CHECK (purpose IN ('login', 'step_up')),
  expected_session_id UUID REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  operation_hash CHAR(64),
  correlation_id UUID NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)),
  CHECK (
    (purpose = 'login' AND expected_session_id IS NULL AND operation_hash IS NULL)
    OR (purpose = 'step_up' AND expected_session_id IS NOT NULL
      AND operation_hash IS NOT NULL AND operation_hash ~ '^[0-9a-f]{64}$')
  )
);
CREATE INDEX platform_passkey_auth_expiry_idx ON platform_passkey_auth_transactions (expires_at);
CREATE INDEX platform_passkey_auth_operator_idx
  ON platform_passkey_auth_transactions (operator_id, environment, expires_at) WHERE consumed_at IS NULL;

REVOKE ALL ON platform_passkey_credentials, platform_passkey_auth_transactions FROM PUBLIC;

CREATE FUNCTION protect_platform_passkey_credential()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invalidate_sessions BOOLEAN := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    invalidate_sessions := true;
    PERFORM id FROM platform_operators WHERE id = NEW.operator_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PLATFORM_PASSKEY_OPERATOR_INACTIVE' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM platform_passkey_credentials
        WHERE operator_id = NEW.operator_id AND environment = NEW.environment AND revoked_at IS NULL) >= 5 THEN
      RAISE EXCEPTION 'PLATFORM_PASSKEY_CAPACITY' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  ELSE
    invalidate_sessions := OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL;
    IF ROW(NEW.id, NEW.operator_id, NEW.environment, NEW.credential_id, NEW.public_key,
           NEW.user_handle, NEW.backup_eligible, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.operator_id, OLD.environment, OLD.credential_id, OLD.public_key,
           OLD.user_handle, OLD.backup_eligible, OLD.created_at)
       OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
       OR NEW.signature_counter < OLD.signature_counter
       OR (OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)) THEN
      RAISE EXCEPTION 'PLATFORM_PASSKEY_CREDENTIAL_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF invalidate_sessions THEN
    UPDATE platform_operators SET security_version = security_version + 1 WHERE id = NEW.operator_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_passkey_credential_protection
BEFORE INSERT OR UPDATE OR DELETE ON platform_passkey_credentials
FOR EACH ROW EXECUTE FUNCTION protect_platform_passkey_credential();
REVOKE ALL ON FUNCTION protect_platform_passkey_credential() FROM PUBLIC;
