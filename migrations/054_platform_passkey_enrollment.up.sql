ALTER TABLE platform_passkey_auth_transactions ADD COLUMN primary_authenticated_at TIMESTAMPTZ;
ALTER TABLE platform_passkey_auth_transactions DROP CONSTRAINT platform_passkey_auth_transactions_purpose_check;
ALTER TABLE platform_passkey_auth_transactions DROP CONSTRAINT platform_passkey_auth_transactions_check2;
ALTER TABLE platform_passkey_auth_transactions ADD CONSTRAINT platform_passkey_auth_transactions_purpose_check
  CHECK (purpose IN ('login', 'step_up', 'enroll'));
ALTER TABLE platform_passkey_auth_transactions ADD CONSTRAINT platform_passkey_auth_transactions_check2 CHECK (
  (purpose IN ('login', 'enroll') AND expected_session_id IS NULL AND operation_hash IS NULL)
  OR (purpose = 'step_up' AND expected_session_id IS NOT NULL
    AND operation_hash IS NOT NULL AND operation_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE platform_passkey_auth_transactions ADD CONSTRAINT platform_passkey_primary_time_valid CHECK (
  (purpose = 'enroll' AND primary_authenticated_at IS NOT NULL
    AND primary_authenticated_at >= created_at - INTERVAL '5 minutes'
    AND primary_authenticated_at <= created_at + INTERVAL '1 minute')
  OR (purpose <> 'enroll' AND primary_authenticated_at IS NULL)
);

CREATE TABLE platform_passkey_enrollment_grants (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  operator_security_version BIGINT NOT NULL CHECK (operator_security_version >= 1),
  environment VARCHAR(4) NOT NULL CHECK (environment IN ('dev', 'int', 'prod')),
  security_epoch BIGINT NOT NULL CHECK (security_epoch >= 1),
  provider VARCHAR(32) NOT NULL CHECK (provider = 'microsoft_entra_platform'),
  provider_tenant_reference UUID NOT NULL,
  provider_subject_reference UUID NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('bootstrap', 'recovery', 'additional')),
  approval_reference VARCHAR(128) NOT NULL CHECK (approval_reference ~ '^[A-Z][A-Z0-9._:-]{3,127}$'),
  issuer_role VARCHAR(63) NOT NULL CHECK (issuer_role ~ '^[a-z][a-z0-9_]{2,62}$'),
  issued_from_session_id UUID REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK ((kind = 'additional' AND issued_from_session_id IS NOT NULL)
    OR (kind IN ('bootstrap', 'recovery') AND issued_from_session_id IS NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '15 minutes'
    AND (kind <> 'additional' OR expires_at <= created_at + INTERVAL '5 minutes')),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX platform_passkey_enrollment_grant_operator_idx
  ON platform_passkey_enrollment_grants (operator_id, environment, expires_at);

CREATE TABLE platform_passkey_enrollment_transactions (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL UNIQUE REFERENCES platform_passkey_enrollment_grants(id) ON DELETE RESTRICT,
  state_hash CHAR(64) NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash CHAR(64) NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  registration_challenge VARCHAR(43) NOT NULL CHECK (registration_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  possession_challenge VARCHAR(43) NOT NULL CHECK (possession_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  user_handle VARCHAR(43) NOT NULL CHECK (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  correlation_id UUID NOT NULL,
  registration_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (registration_attempts BETWEEN 0 AND 5),
  possession_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (possession_attempts BETWEEN 0 AND 5),
  candidate_id VARCHAR(1366),
  candidate_public_key VARCHAR(512),
  candidate_counter BIGINT,
  candidate_backup_eligible BOOLEAN,
  candidate_backed_up BOOLEAN,
  staged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (registration_challenge <> possession_challenge),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  CHECK (consumed_at IS NULL OR (staged_at IS NOT NULL AND consumed_at >= staged_at AND consumed_at < expires_at)),
  CHECK ((candidate_id IS NULL AND candidate_public_key IS NULL AND candidate_counter IS NULL
      AND candidate_backup_eligible IS NULL AND candidate_backed_up IS NULL AND staged_at IS NULL)
    OR (candidate_id IS NOT NULL AND candidate_id ~ '^[A-Za-z0-9_-]+$'
      AND candidate_public_key IS NOT NULL AND candidate_public_key ~ '^[A-Za-z0-9_-]+$'
      AND candidate_counter IS NOT NULL AND candidate_counter BETWEEN 0 AND 4294967295
      AND candidate_backup_eligible IS NOT NULL AND candidate_backed_up IS NOT NULL
      AND (NOT candidate_backed_up OR candidate_backup_eligible)
      AND staged_at IS NOT NULL AND staged_at >= created_at AND staged_at < expires_at))
);

REVOKE ALL ON platform_passkey_enrollment_grants, platform_passkey_enrollment_transactions FROM PUBLIC;

CREATE FUNCTION authorize_platform_passkey_enrollment_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operator_row platform_operators%ROWTYPE;
  table_owner text;
  active_count integer;
BEGIN
  SELECT * INTO operator_row FROM platform_operators
    WHERE id = NEW.operator_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND OR operator_row.provider <> NEW.provider
    OR lower(operator_row.provider_tenant_reference) <> NEW.provider_tenant_reference::text
    OR lower(operator_row.provider_subject_reference) <> NEW.provider_subject_reference::text
    OR NEW.issuer_role <> current_user THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_GRANT_AUTHORITY_REJECTED' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO active_count FROM platform_passkey_credentials
    WHERE operator_id = NEW.operator_id AND environment = NEW.environment AND revoked_at IS NULL;
  IF NEW.kind IN ('bootstrap', 'recovery') THEN
    SELECT pg_get_userbyid(relowner) INTO table_owner FROM pg_class
      WHERE oid = 'public.platform_passkey_enrollment_grants'::regclass;
    IF session_user <> current_user OR current_user <> table_owner OR active_count <> 0 THEN
      RAISE EXCEPTION 'PLATFORM_PASSKEY_OFFLINE_OWNER_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'bootstrap' THEN
      IF NEW.operator_security_version <> operator_row.security_version OR EXISTS (
        SELECT 1 FROM platform_passkey_credentials WHERE operator_id = NEW.operator_id AND environment = NEW.environment
      ) THEN
        RAISE EXCEPTION 'PLATFORM_PASSKEY_BOOTSTRAP_ALREADY_USED' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.operator_security_version <> operator_row.security_version + 1 OR NOT EXISTS (
        SELECT 1 FROM platform_passkey_credentials WHERE operator_id = NEW.operator_id AND environment = NEW.environment
      ) THEN
        RAISE EXCEPTION 'PLATFORM_PASSKEY_RECOVERY_AUTHORITY_REJECTED' USING ERRCODE = '23514';
      END IF;
      -- A nested trigger is the existing managed security-version boundary.
      UPDATE platform_operators SET security_version = security_version + 1 WHERE id = NEW.operator_id;
    END IF;
  ELSE
    IF NEW.operator_security_version <> operator_row.security_version OR active_count NOT BETWEEN 1 AND 4
      OR NOT EXISTS (SELECT 1 FROM platform_sessions WHERE id = NEW.issued_from_session_id
        AND operator_id = NEW.operator_id AND principal_version = operator_row.security_version
        AND security_epoch = NEW.security_epoch AND revoked_at IS NULL AND expires_at > clock_timestamp()
        AND assurance_level = 'step_up' AND authentication_context = 'cm:pk:v1'
        AND step_up_expires_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'PLATFORM_PASSKEY_ADDITION_STRONG_SESSION_REQUIRED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_passkey_enrollment_grant_authority
BEFORE INSERT ON platform_passkey_enrollment_grants
FOR EACH ROW EXECUTE FUNCTION authorize_platform_passkey_enrollment_grant();
REVOKE ALL ON FUNCTION authorize_platform_passkey_enrollment_grant() FROM PUBLIC;

CREATE FUNCTION protect_platform_passkey_enrollment_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_ENROLLMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW.operator_id, NEW.operator_security_version, NEW.environment, NEW.security_epoch,
      NEW.provider, NEW.provider_tenant_reference, NEW.provider_subject_reference, NEW.kind,
      NEW.approval_reference, NEW.issuer_role, NEW.issued_from_session_id, NEW.token_hash,
      NEW.correlation_id, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.operator_id, OLD.operator_security_version, OLD.environment, OLD.security_epoch,
      OLD.provider, OLD.provider_tenant_reference, OLD.provider_subject_reference, OLD.kind,
      OLD.approval_reference, OLD.issuer_role, OLD.issued_from_session_id, OLD.token_hash,
      OLD.correlation_id, OLD.created_at, OLD.expires_at)
    OR ((OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_ENROLLMENT_GRANT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_passkey_enrollment_grant_protection
BEFORE UPDATE OR DELETE ON platform_passkey_enrollment_grants
FOR EACH ROW EXECUTE FUNCTION protect_platform_passkey_enrollment_grant();

CREATE FUNCTION protect_platform_passkey_enrollment_transaction()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_ENROLLMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW.grant_id, NEW.state_hash, NEW.browser_hash, NEW.registration_challenge,
      NEW.possession_challenge, NEW.user_handle, NEW.correlation_id, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.grant_id, OLD.state_hash, OLD.browser_hash, OLD.registration_challenge,
      OLD.possession_challenge, OLD.user_handle, OLD.correlation_id, OLD.created_at, OLD.expires_at)
    OR NEW.registration_attempts < OLD.registration_attempts OR NEW.registration_attempts > OLD.registration_attempts + 1
    OR NEW.possession_attempts < OLD.possession_attempts OR NEW.possession_attempts > OLD.possession_attempts + 1
    OR (OLD.staged_at IS NOT NULL AND ROW(NEW.candidate_id, NEW.candidate_public_key, NEW.candidate_counter,
        NEW.candidate_backup_eligible, NEW.candidate_backed_up, NEW.staged_at)
      IS DISTINCT FROM ROW(OLD.candidate_id, OLD.candidate_public_key, OLD.candidate_counter,
        OLD.candidate_backup_eligible, OLD.candidate_backed_up, OLD.staged_at))
    OR (OLD.consumed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_ENROLLMENT_TRANSACTION_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_passkey_enrollment_transaction_protection
BEFORE UPDATE OR DELETE ON platform_passkey_enrollment_transactions
FOR EACH ROW EXECUTE FUNCTION protect_platform_passkey_enrollment_transaction();
REVOKE ALL ON FUNCTION protect_platform_passkey_enrollment_grant(), protect_platform_passkey_enrollment_transaction() FROM PUBLIC;

-- This audit-only marker cannot satisfy the Platform principal/session schemas.
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_actor_snapshot_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_actor_snapshot_valid CHECK (
  (operator_id IS NULL AND cardinality(roles) = 0 AND cardinality(permissions) = 0
    AND ((action = 'platform.authentication.failed' AND assurance_level = 'unverified')
      OR (action = 'platform.operator.changed' AND assurance_level = 'offline_owner'
        AND target_tenant_id IS NULL AND target_type = 'platform_passkey_grant'
        AND retention_class = 'recovery' AND outcome = 'success')))
  OR (operator_id IS NOT NULL AND platform_roles_are_canonical(roles)
    AND permissions = platform_permissions_for_roles(roles)
    AND assurance_level IN ('mfa', 'step_up', 'break_glass'))
);
