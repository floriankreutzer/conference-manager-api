CREATE FUNCTION platform_roles_are_canonical(candidate TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    cardinality(candidate) BETWEEN 1 AND 4
    AND array_position(candidate, NULL) IS NULL
    AND candidate <@ ARRAY[
      'platform_security_admin',
      'platform_security_auditor',
      'platform_support_reader',
      'platform_tenant_operator'
    ]::TEXT[]
    AND candidate = ARRAY(
      SELECT DISTINCT role
      FROM unnest(candidate) AS role
      ORDER BY role
    )
$$;

CREATE FUNCTION platform_permissions_for_roles(candidate TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT mapping.permission ORDER BY mapping.permission), ARRAY[]::TEXT[])
  FROM (
    VALUES
      ('platform_support_reader', 'platform:tenant:read'),
      ('platform_support_reader', 'platform:readiness:read'),
      ('platform_support_reader', 'platform:integration-health:read'),
      ('platform_support_reader', 'platform:diagnostics:read'),
      ('platform_support_reader', 'platform:entitlement:read'),
      ('platform_support_reader', 'platform:metering:read'),
      ('platform_support_reader', 'platform:runtime:read'),
      ('platform_tenant_operator', 'platform:tenant:read'),
      ('platform_tenant_operator', 'platform:readiness:read'),
      ('platform_tenant_operator', 'platform:integration-health:read'),
      ('platform_tenant_operator', 'platform:diagnostics:read'),
      ('platform_tenant_operator', 'platform:entitlement:read'),
      ('platform_tenant_operator', 'platform:metering:read'),
      ('platform_tenant_operator', 'platform:runtime:read'),
      ('platform_tenant_operator', 'platform:invitation:manage'),
      ('platform_tenant_operator', 'platform:lifecycle:manage'),
      ('platform_tenant_operator', 'platform:entitlement:manage'),
      ('platform_tenant_operator', 'platform:quota:manage'),
      ('platform_security_auditor', 'platform:tenant:read'),
      ('platform_security_auditor', 'platform:diagnostics:read'),
      ('platform_security_auditor', 'platform:diagnostics:sensitive'),
      ('platform_security_auditor', 'platform:audit:read'),
      ('platform_security_auditor', 'platform:audit:export'),
      ('platform_security_auditor', 'platform:runtime:read'),
      ('platform_security_admin', 'platform:tenant:read'),
      ('platform_security_admin', 'platform:diagnostics:read'),
      ('platform_security_admin', 'platform:diagnostics:sensitive'),
      ('platform_security_admin', 'platform:recovery:execute'),
      ('platform_security_admin', 'platform:audit:read'),
      ('platform_security_admin', 'platform:session:revoke'),
      ('platform_security_admin', 'platform:operator:manage'),
      ('platform_security_admin', 'platform:break-glass:manage')
  ) AS mapping(role, permission)
  WHERE mapping.role = ANY(candidate)
$$;

CREATE TABLE platform_operators (
  id UUID PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  provider_tenant_reference VARCHAR(255) NOT NULL,
  provider_subject_reference VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  scope_mode VARCHAR(16) NOT NULL DEFAULT 'allowlist',
  roles TEXT[] NOT NULL,
  security_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_operators_identity_unique
    UNIQUE (provider, provider_tenant_reference, provider_subject_reference),
  CONSTRAINT platform_operators_provider_valid
    CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT platform_operators_tenant_reference_valid
    CHECK (provider_tenant_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$'),
  CONSTRAINT platform_operators_subject_reference_valid
    CHECK (provider_subject_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$'),
  CONSTRAINT platform_operators_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT platform_operators_scope_mode_valid CHECK (scope_mode IN ('all', 'allowlist')),
  CONSTRAINT platform_operators_roles_valid CHECK (platform_roles_are_canonical(roles)),
  CONSTRAINT platform_operators_security_version_valid CHECK (security_version >= 1)
);

CREATE FUNCTION enforce_platform_operator_security_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.security_version <> OLD.security_version THEN
    IF pg_trigger_depth() < 2
       OR NEW.security_version <> OLD.security_version + 1
       OR ROW(NEW.provider, NEW.provider_tenant_reference, NEW.provider_subject_reference,
              NEW.status, NEW.scope_mode, NEW.roles)
          IS DISTINCT FROM
          ROW(OLD.provider, OLD.provider_tenant_reference, OLD.provider_subject_reference,
              OLD.status, OLD.scope_mode, OLD.roles) THEN
      RAISE EXCEPTION 'PLATFORM_OPERATOR_SECURITY_VERSION_MANAGED' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW.provider, NEW.provider_tenant_reference, NEW.provider_subject_reference,
         NEW.status, NEW.scope_mode, NEW.roles)
     IS DISTINCT FROM
     ROW(OLD.provider, OLD.provider_tenant_reference, OLD.provider_subject_reference,
         OLD.status, OLD.scope_mode, OLD.roles) THEN
    NEW.security_version := OLD.security_version + 1;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_operator_security_version
BEFORE UPDATE ON platform_operators
FOR EACH ROW
EXECUTE FUNCTION enforce_platform_operator_security_version();

CREATE TABLE platform_operator_tenant_scopes (
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operator_id, tenant_id)
);

CREATE FUNCTION invalidate_platform_operator_scope_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_operator_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_TENANT_SCOPE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  affected_operator_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.operator_id ELSE NEW.operator_id END;
  UPDATE platform_operators
  SET security_version = security_version + 1
  WHERE id = affected_operator_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER platform_operator_tenant_scope_invalidation
AFTER INSERT OR UPDATE OR DELETE ON platform_operator_tenant_scopes
FOR EACH ROW
EXECUTE FUNCTION invalidate_platform_operator_scope_sessions();

CREATE TABLE platform_sessions (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE,
  provider VARCHAR(64) NOT NULL,
  provider_tenant_reference VARCHAR(255) NOT NULL,
  provider_subject_reference VARCHAR(255) NOT NULL,
  roles TEXT[] NOT NULL,
  permissions TEXT[] NOT NULL,
  principal_version BIGINT NOT NULL,
  scope_mode VARCHAR(16) NOT NULL,
  security_epoch BIGINT NOT NULL,
  assurance_level VARCHAR(16) NOT NULL,
  authentication_context VARCHAR(128) NOT NULL,
  authenticated_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  step_up_expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replaced_by_session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_sessions_replacement_fk
    FOREIGN KEY (replaced_by_session_id) REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT platform_sessions_replacement_distinct CHECK (replaced_by_session_id IS DISTINCT FROM id),
  CONSTRAINT platform_sessions_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_sessions_provider_valid CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT platform_sessions_tenant_reference_valid
    CHECK (provider_tenant_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$'),
  CONSTRAINT platform_sessions_subject_reference_valid
    CHECK (provider_subject_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$'),
  CONSTRAINT platform_sessions_roles_valid CHECK (platform_roles_are_canonical(roles)),
  CONSTRAINT platform_sessions_permissions_valid CHECK (permissions = platform_permissions_for_roles(roles)),
  CONSTRAINT platform_sessions_principal_version_valid CHECK (principal_version >= 1),
  CONSTRAINT platform_sessions_scope_mode_valid CHECK (scope_mode IN ('all', 'allowlist')),
  CONSTRAINT platform_sessions_security_epoch_valid CHECK (security_epoch >= 1),
  CONSTRAINT platform_sessions_assurance_valid CHECK (assurance_level IN ('mfa', 'step_up')),
  CONSTRAINT platform_sessions_authentication_context_valid
    CHECK (authentication_context ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  CONSTRAINT platform_sessions_time_valid CHECK (
    authenticated_at <= issued_at + INTERVAL '1 minute'
    AND expires_at > issued_at
    AND expires_at <= issued_at + INTERVAL '24 hours'
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
  ),
  CONSTRAINT platform_sessions_step_up_valid CHECK (
    (assurance_level = 'mfa' AND step_up_expires_at IS NULL)
    OR (assurance_level = 'step_up' AND step_up_expires_at IS NOT NULL
        AND step_up_expires_at > issued_at AND step_up_expires_at <= expires_at
        AND step_up_expires_at <= authenticated_at + INTERVAL '5 minutes')
  )
);

CREATE INDEX platform_sessions_operator_active_idx
  ON platform_sessions (operator_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE platform_oidc_auth_transactions (
  state_hash CHAR(64) PRIMARY KEY,
  nonce_hash CHAR(64) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  expected_operator_id UUID REFERENCES platform_operators(id) ON DELETE RESTRICT,
  expected_session_id UUID REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  expected_security_version BIGINT,
  security_epoch BIGINT NOT NULL,
  authentication_context VARCHAR(128) NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_oidc_state_hash_valid CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_oidc_nonce_hash_valid CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_oidc_purpose_valid CHECK (purpose IN ('login', 'step_up')),
  CONSTRAINT platform_oidc_security_epoch_valid CHECK (security_epoch >= 1),
  CONSTRAINT platform_oidc_context_valid
    CHECK (authentication_context ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  CONSTRAINT platform_oidc_expiry_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + INTERVAL '10 minutes'
  ),
  CONSTRAINT platform_oidc_binding_valid CHECK (
    (purpose = 'login' AND expected_operator_id IS NULL AND expected_session_id IS NULL
      AND expected_security_version IS NULL)
    OR
    (purpose = 'step_up' AND expected_operator_id IS NOT NULL AND expected_session_id IS NOT NULL
      AND expected_security_version >= 1)
  )
);

CREATE INDEX platform_oidc_expiry_idx ON platform_oidc_auth_transactions (expires_at);

CREATE TABLE platform_break_glass_grants (
  id UUID PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  operator_security_version BIGINT NOT NULL,
  approver_operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  approver_security_version BIGINT NOT NULL,
  target_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  permission VARCHAR(128) NOT NULL,
  reason VARCHAR(512) NOT NULL,
  approval_reference VARCHAR(128) NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_operator_id UUID REFERENCES platform_operators(id) ON DELETE RESTRICT,
  revocation_approver_operator_id UUID REFERENCES platform_operators(id) ON DELETE RESTRICT,
  revocation_approver_security_version BIGINT,
  revocation_reason VARCHAR(512),
  revocation_approval_reference VARCHAR(128),
  CONSTRAINT platform_break_glass_separation_of_duties CHECK (operator_id <> approver_operator_id),
  CONSTRAINT platform_break_glass_operator_version_valid CHECK (operator_security_version >= 1),
  CONSTRAINT platform_break_glass_approver_version_valid CHECK (approver_security_version >= 1),
  CONSTRAINT platform_break_glass_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_break_glass_permission_valid CHECK (permission IN (
    'platform:lifecycle:manage',
    'platform:entitlement:manage',
    'platform:recovery:execute',
    'platform:session:revoke'
  )),
  CONSTRAINT platform_break_glass_reason_valid CHECK (
    char_length(reason) BETWEEN 10 AND 512 AND reason = btrim(reason)
  ),
  CONSTRAINT platform_break_glass_approval_valid CHECK (
    approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$'
  ),
  CONSTRAINT platform_break_glass_expiry_valid CHECK (
    expires_at > issued_at AND expires_at <= issued_at + INTERVAL '30 minutes'
  ),
  CONSTRAINT platform_break_glass_terminal_time_valid CHECK (
    (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at))
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
    AND NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT platform_break_glass_revocation_valid CHECK (
    (revoked_at IS NULL
      AND revoked_by_operator_id IS NULL
      AND revocation_approver_operator_id IS NULL
      AND revocation_approver_security_version IS NULL
      AND revocation_reason IS NULL
      AND revocation_approval_reference IS NULL)
    OR
    (revoked_at IS NOT NULL
      AND revoked_by_operator_id IS NOT NULL
      AND revocation_approver_operator_id IS NOT NULL
      AND revocation_approver_security_version >= 1
      AND revoked_by_operator_id <> revocation_approver_operator_id
      AND char_length(revocation_reason) BETWEEN 10 AND 512
      AND revocation_reason = btrim(revocation_reason)
      AND revocation_approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$')
  )
);

CREATE INDEX platform_break_glass_active_idx
  ON platform_break_glass_grants (operator_id, target_tenant_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION protect_platform_break_glass_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLATFORM_BREAK_GLASS_GRANTS_RETAINED' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW.token_hash, NEW.operator_id, NEW.operator_security_version,
         NEW.approver_operator_id, NEW.approver_security_version,
         NEW.target_tenant_id, NEW.permission, NEW.reason, NEW.approval_reference,
         NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.token_hash, OLD.operator_id, OLD.operator_security_version,
         OLD.approver_operator_id, OLD.approver_security_version,
         OLD.target_tenant_id, OLD.permission, OLD.reason, OLD.approval_reference,
         OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'PLATFORM_BREAK_GLASS_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'PLATFORM_BREAK_GLASS_GRANT_TERMINAL' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_break_glass_grant_protection
BEFORE UPDATE OR DELETE ON platform_break_glass_grants
FOR EACH ROW
EXECUTE FUNCTION protect_platform_break_glass_grant();

CREATE TABLE platform_break_glass_alert_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES platform_break_glass_grants(id) ON DELETE RESTRICT,
  event_type VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  CONSTRAINT platform_break_glass_alert_unique UNIQUE (grant_id, event_type),
  CONSTRAINT platform_break_glass_alert_type_valid CHECK (event_type IN ('issued', 'used', 'revoked')),
  CONSTRAINT platform_break_glass_alert_delivery_valid
    CHECK (delivered_at IS NULL OR delivered_at >= created_at)
);

CREATE TABLE platform_security_alert_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  target_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  correlation_id UUID NOT NULL UNIQUE,
  reason_code VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  CONSTRAINT platform_security_alert_type_valid CHECK (event_type IN ('break_glass_denied')),
  CONSTRAINT platform_security_alert_reason_valid
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT platform_security_alert_delivery_valid
    CHECK (delivered_at IS NULL OR delivered_at >= created_at)
);

CREATE TABLE platform_operator_change_alert_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  change_type VARCHAR(32) NOT NULL,
  correlation_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  CONSTRAINT platform_operator_change_alert_type_valid
    CHECK (change_type IN ('created', 'access_changed', 'disabled')),
  CONSTRAINT platform_operator_change_alert_delivery_valid
    CHECK (delivered_at IS NULL OR delivered_at >= created_at)
);
