CREATE FUNCTION platform_add_utc_months(candidate TIMESTAMPTZ, month_count INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT (
    (candidate AT TIME ZONE 'UTC') + make_interval(months => month_count)
  ) AT TIME ZONE 'UTC'
$$;

ALTER TABLE tenants
  ADD COLUMN lifecycle_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN entitlement_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN customer_session_revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT tenants_lifecycle_revision_valid CHECK (lifecycle_revision >= 1),
  ADD CONSTRAINT tenants_entitlement_revision_valid CHECK (entitlement_revision >= 1),
  ADD CONSTRAINT tenants_customer_session_revision_valid CHECK (customer_session_revision >= 1);

CREATE FUNCTION manage_tenant_platform_revisions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.lifecycle_revision = OLD.lifecycle_revision THEN
      NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
    ELSIF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
      RAISE EXCEPTION 'TENANT_LIFECYCLE_REVISION_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.lifecycle_revision <> OLD.lifecycle_revision THEN
    RAISE EXCEPTION 'TENANT_LIFECYCLE_REVISION_MANAGED' USING ERRCODE = '23514';
  END IF;

  IF NEW.entitlement_revision <> OLD.entitlement_revision THEN
    IF NEW.entitlement_revision <> OLD.entitlement_revision + 1 THEN
      RAISE EXCEPTION 'TENANT_ENTITLEMENT_REVISION_MANAGED' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.customer_session_revision <> OLD.customer_session_revision
     AND NEW.customer_session_revision <> OLD.customer_session_revision + 1 THEN
    RAISE EXCEPTION 'TENANT_SESSION_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_platform_revisions
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION manage_tenant_platform_revisions();

ALTER TABLE tenant_onboarding_invitations
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN reissued_from_id UUID,
  ADD CONSTRAINT tenant_onboarding_invitations_revision_valid CHECK (revision >= 1),
  ADD CONSTRAINT tenant_onboarding_invitations_terminal_valid CHECK (
    NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  ADD CONSTRAINT tenant_onboarding_invitations_reissue_distinct
    CHECK (reissued_from_id IS NULL OR reissued_from_id <> id),
  ADD CONSTRAINT tenant_onboarding_invitations_reissue_fk
    FOREIGN KEY (reissued_from_id) REFERENCES tenant_onboarding_invitations(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX tenant_onboarding_invitations_open_tenant_idx
  ON tenant_onboarding_invitations (tenant_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX tenant_onboarding_invitations_reissue_unique_idx
  ON tenant_onboarding_invitations (reissued_from_id)
  WHERE reissued_from_id IS NOT NULL;

CREATE FUNCTION protect_tenant_onboarding_invitation_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.token_hash, NEW.created_at, NEW.expires_at, NEW.reissued_from_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.token_hash, OLD.created_at, OLD.expires_at, OLD.reissued_from_id) THEN
    RAISE EXCEPTION 'TENANT_INVITATION_AUTHORITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.consumed_at, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.consumed_at, OLD.revoked_at) THEN
    IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'TENANT_INVITATION_TERMINAL' USING ERRCODE = '55000';
    END IF;
    IF NEW.revision = OLD.revision THEN
      NEW.revision := OLD.revision + 1;
    ELSIF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'TENANT_INVITATION_REVISION_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'TENANT_INVITATION_REVISION_MANAGED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_onboarding_invitations_revision_guard
BEFORE UPDATE ON tenant_onboarding_invitations
FOR EACH ROW EXECUTE FUNCTION protect_tenant_onboarding_invitation_revision();

ALTER TABLE tenant_identity_bindings
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT tenant_identity_bindings_revision_valid CHECK (revision >= 1);

CREATE FUNCTION manage_tenant_identity_binding_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.provider_tenant_reference, NEW.status, NEW.claimant_provider_user_reference)
     IS DISTINCT FROM
     ROW(OLD.provider_tenant_reference, OLD.status, OLD.claimant_provider_user_reference) THEN
    IF NEW.revision = OLD.revision THEN
      NEW.revision := OLD.revision + 1;
    ELSIF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'TENANT_IDENTITY_BINDING_REVISION_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'TENANT_IDENTITY_BINDING_REVISION_MANAGED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_identity_bindings_revision_guard
BEFORE UPDATE ON tenant_identity_bindings
FOR EACH ROW EXECUTE FUNCTION manage_tenant_identity_binding_revision();

ALTER TABLE microsoft365_room_mappings
  ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT microsoft365_room_mappings_id_unique UNIQUE (id),
  ADD CONSTRAINT microsoft365_room_mappings_revision_valid CHECK (revision >= 1);

CREATE FUNCTION manage_microsoft365_room_mapping_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.integration_id, NEW.external_room_id, NEW.resource_address,
         NEW.provider_display_name, NEW.provider_capacity, NEW.provider_status)
     IS DISTINCT FROM
     ROW(OLD.integration_id, OLD.external_room_id, OLD.resource_address,
         OLD.provider_display_name, OLD.provider_capacity, OLD.provider_status) THEN
    IF NEW.revision = OLD.revision THEN
      NEW.revision := OLD.revision + 1;
    ELSIF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'MICROSOFT365_ROOM_MAPPING_REVISION_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'MICROSOFT365_ROOM_MAPPING_REVISION_MANAGED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER microsoft365_room_mappings_revision_guard
BEFORE UPDATE ON microsoft365_room_mappings
FOR EACH ROW EXECUTE FUNCTION manage_microsoft365_room_mapping_revision();

CREATE TABLE platform_operation_receipts (
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  operation VARCHAR(96) NOT NULL,
  target_tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_digest CHAR(64) NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_operation_receipts_digest_valid CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_operation_receipts_operation_valid CHECK (operation IN (
    'tenant.invitation.create',
    'tenant.invitation.revoke',
    'tenant.invitation.reissue',
    'tenant.lifecycle.transition',
    'tenant.entitlement.apply',
    'tenant.recovery.last_admin',
    'tenant.recovery.microsoft_reconsent',
    'tenant.recovery.room_mapping',
    'tenant.recovery.identity_unbind',
    'tenant.recovery.tenant_sessions',
    'tenant.recovery.user_sessions',
    'tenant.recovery.suspend',
    'tenant.recovery.reactivate'
  )),
  CONSTRAINT platform_operation_receipts_result_valid CHECK (
    jsonb_typeof(result) = 'object' AND octet_length(result::TEXT) <= 65536
  ),
  CONSTRAINT platform_operation_receipts_retention_valid CHECK (
    retain_until >= platform_add_utc_months(created_at, 24)
  )
);

CREATE UNIQUE INDEX platform_operation_receipts_tenant_key_idx
  ON platform_operation_receipts (operator_id, operation, target_tenant_id, idempotency_key)
  WHERE target_tenant_id IS NOT NULL;
CREATE UNIQUE INDEX platform_operation_receipts_global_key_idx
  ON platform_operation_receipts (operator_id, operation, idempotency_key)
  WHERE target_tenant_id IS NULL;
CREATE INDEX platform_operation_receipts_retention_idx
  ON platform_operation_receipts (retain_until);

CREATE FUNCTION protect_platform_operation_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PLATFORM_OPERATION_RECEIPT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF clock_timestamp() < OLD.retain_until THEN
    RAISE EXCEPTION 'PLATFORM_OPERATION_RECEIPT_RETAINED' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER platform_operation_receipts_protected
BEFORE UPDATE OR DELETE ON platform_operation_receipts
FOR EACH ROW EXECUTE FUNCTION protect_platform_operation_receipt();

CREATE TABLE platform_entitlement_packages (
  package_id VARCHAR(96) PRIMARY KEY,
  revision BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL,
  status VARCHAR(16) NOT NULL,
  proposals JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_entitlement_packages_id_valid CHECK (package_id ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  CONSTRAINT platform_entitlement_packages_revision_valid CHECK (revision >= 1),
  CONSTRAINT platform_entitlement_packages_name_valid CHECK (
    char_length(name) BETWEEN 1 AND 120 AND name = btrim(name) AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT platform_entitlement_packages_description_valid CHECK (
    char_length(description) <= 500 AND description = btrim(description) AND description !~ '[[:cntrl:]]'
  ),
  CONSTRAINT platform_entitlement_packages_status_valid CHECK (status IN ('active', 'retired')),
  CONSTRAINT platform_entitlement_packages_proposals_valid CHECK (
    jsonb_typeof(proposals) = 'array'
    AND jsonb_array_length(proposals) BETWEEN 1 AND 64
    AND octet_length(proposals::TEXT) <= 8192
  ),
  CONSTRAINT platform_entitlement_packages_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE FUNCTION protect_platform_entitlement_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLATFORM_ENTITLEMENT_PACKAGE_HISTORY_REQUIRED' USING ERRCODE = '55000';
  END IF;
  IF NEW.package_id <> OLD.package_id
     OR NEW.revision <> OLD.revision + 1
     OR NEW.created_at <> OLD.created_at
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PLATFORM_ENTITLEMENT_PACKAGE_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_entitlement_packages_protected
BEFORE UPDATE OR DELETE ON platform_entitlement_packages
FOR EACH ROW EXECUTE FUNCTION protect_platform_entitlement_package();

CREATE TABLE platform_entitlement_package_revisions (
  package_id VARCHAR(96) NOT NULL REFERENCES platform_entitlement_packages(package_id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL,
  status VARCHAR(16) NOT NULL,
  proposals JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (package_id, revision),
  CONSTRAINT platform_entitlement_package_revision_valid CHECK (revision >= 1),
  CONSTRAINT platform_entitlement_package_revision_status_valid CHECK (status IN ('active', 'retired')),
  CONSTRAINT platform_entitlement_package_revision_proposals_valid CHECK (
    jsonb_typeof(proposals) = 'array'
    AND jsonb_array_length(proposals) BETWEEN 1 AND 64
    AND octet_length(proposals::TEXT) <= 8192
  )
);

CREATE TABLE platform_entitlement_change_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entitlement_revision BIGINT NOT NULL,
  capability_id VARCHAR(64) NOT NULL,
  previous_enabled BOOLEAN NOT NULL,
  enabled BOOLEAN NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  package_id VARCHAR(96),
  package_revision BIGINT,
  correlation_id UUID NOT NULL,
  reason VARCHAR(500) NOT NULL,
  CONSTRAINT platform_entitlement_history_change_unique
    UNIQUE (tenant_id, entitlement_revision, capability_id),
  CONSTRAINT platform_entitlement_history_capability_valid CHECK (
    capability_id IN ('microsoft.directory', 'microsoft.calendar', 'microsoft.calendar.write')
  ),
  CONSTRAINT platform_entitlement_history_changed CHECK (previous_enabled <> enabled),
  CONSTRAINT platform_entitlement_history_revision_valid CHECK (entitlement_revision >= 2),
  CONSTRAINT platform_entitlement_history_package_valid CHECK (
    (package_id IS NULL AND package_revision IS NULL)
    OR (package_id IS NOT NULL AND package_revision >= 1)
  ),
  CONSTRAINT platform_entitlement_history_reason_valid CHECK (
    char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason) AND reason !~ '[[:cntrl:]]'
  )
);

CREATE INDEX platform_entitlement_history_tenant_time_idx
  ON platform_entitlement_change_history (tenant_id, effective_at DESC, id DESC);

CREATE FUNCTION reject_platform_operations_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_OPERATIONS_HISTORY_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER platform_entitlement_package_revisions_append_only
BEFORE UPDATE OR DELETE ON platform_entitlement_package_revisions
FOR EACH ROW EXECUTE FUNCTION reject_platform_operations_history_mutation();
CREATE TRIGGER platform_entitlement_change_history_append_only
BEFORE UPDATE OR DELETE ON platform_entitlement_change_history
FOR EACH ROW EXECUTE FUNCTION reject_platform_operations_history_mutation();
