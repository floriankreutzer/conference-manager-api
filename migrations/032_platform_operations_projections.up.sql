CREATE TABLE platform_tenant_readiness_snapshots (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  source_lifecycle_revision BIGINT NOT NULL,
  source_entitlement_revision BIGINT NOT NULL,
  onboarding_state VARCHAR(16) NOT NULL,
  readiness_state VARCHAR(16) NOT NULL,
  blocker_codes TEXT[] NOT NULL,
  checks JSONB NOT NULL,
  enabled_entitlement_count INTEGER NOT NULL,
  missing_required_entitlement_count INTEGER NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason VARCHAR(96),
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_readiness_snapshot_source_valid CHECK (
    source_lifecycle_revision >= 1 AND source_entitlement_revision >= 1
  ),
  CONSTRAINT platform_readiness_snapshot_onboarding_valid CHECK (
    onboarding_state IN ('not_started', 'invited', 'claim_pending', 'claimed', 'complete')
  ),
  CONSTRAINT platform_readiness_snapshot_state_valid CHECK (
    readiness_state IN ('ready', 'blocked', 'stale', 'unknown')
  ),
  CONSTRAINT platform_readiness_snapshot_blockers_valid CHECK (
    cardinality(blocker_codes) <= 64 AND array_position(blocker_codes, NULL) IS NULL
  ),
  CONSTRAINT platform_readiness_snapshot_checks_valid CHECK (
    jsonb_typeof(checks) = 'array'
    AND jsonb_array_length(checks) <= 64
    AND octet_length(checks::TEXT) <= 32768
  ),
  CONSTRAINT platform_readiness_snapshot_counts_valid CHECK (
    enabled_entitlement_count BETWEEN 0 AND 64
    AND missing_required_entitlement_count BETWEEN 0 AND 64
  ),
  CONSTRAINT platform_readiness_snapshot_revision_valid CHECK (revision >= 1),
  CONSTRAINT platform_readiness_snapshot_invalidation_valid CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND invalidation_reason ~ '^[a-z][a-z0-9_.-]{0,95}$'
        AND invalidated_at >= evaluated_at)
  ),
  CONSTRAINT platform_readiness_snapshot_time_valid CHECK (updated_at >= evaluated_at)
);

CREATE INDEX platform_readiness_snapshot_fleet_idx
  ON platform_tenant_readiness_snapshots (readiness_state, tenant_id);
CREATE INDEX platform_readiness_snapshot_blockers_idx
  ON platform_tenant_readiness_snapshots USING GIN (blocker_codes);

CREATE TABLE platform_tenant_readiness_evidence (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind VARCHAR(16) NOT NULL,
  state VARCHAR(16) NOT NULL,
  release VARCHAR(80),
  verified_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason VARCHAR(96),
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, kind, revision),
  CONSTRAINT platform_readiness_evidence_kind_valid CHECK (kind IN ('repository', 'deployment', 'external')),
  CONSTRAINT platform_readiness_evidence_state_valid CHECK (state IN ('verified', 'missing', 'invalid', 'unknown')),
  CONSTRAINT platform_readiness_evidence_release_valid CHECK (
    release IS NULL OR release ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$'
  ),
  CONSTRAINT platform_readiness_evidence_time_valid CHECK (
    (verified_at IS NULL OR valid_until IS NULL OR valid_until > verified_at)
    AND recorded_at >= COALESCE(verified_at, recorded_at)
  ),
  CONSTRAINT platform_readiness_evidence_revision_valid CHECK (revision >= 1),
  CONSTRAINT platform_readiness_evidence_invalidation_valid CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND invalidation_reason ~ '^[a-z][a-z0-9_.-]{0,95}$')
  )
);

CREATE INDEX platform_readiness_evidence_release_idx
  ON platform_tenant_readiness_evidence (kind, release, tenant_id, revision DESC);

CREATE TABLE platform_microsoft_fleet_snapshots (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  source_lifecycle_revision BIGINT NOT NULL,
  connection_state VARCHAR(16) NOT NULL,
  places_permission VARCHAR(16) NOT NULL,
  calendars_permission VARCHAR(16) NOT NULL,
  active_mapping_count INTEGER NOT NULL,
  missing_mapping_count INTEGER NOT NULL,
  total_mapping_count INTEGER NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason VARCHAR(96),
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_microsoft_snapshot_lifecycle_valid CHECK (source_lifecycle_revision >= 1),
  CONSTRAINT platform_microsoft_snapshot_connection_valid CHECK (
    connection_state IN ('not_configured', 'connected', 'degraded', 'disconnected')
  ),
  CONSTRAINT platform_microsoft_snapshot_permissions_valid CHECK (
    places_permission IN ('granted', 'missing', 'unknown')
    AND calendars_permission IN ('granted', 'missing', 'unknown')
  ),
  CONSTRAINT platform_microsoft_snapshot_mapping_counts_valid CHECK (
    active_mapping_count >= 0
    AND missing_mapping_count >= 0
    AND total_mapping_count >= 0
    AND active_mapping_count + missing_mapping_count <= total_mapping_count
  ),
  CONSTRAINT platform_microsoft_snapshot_revision_valid CHECK (revision >= 1),
  CONSTRAINT platform_microsoft_snapshot_invalidation_valid CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND invalidation_reason ~ '^[a-z][a-z0-9_.-]{0,95}$'
        AND invalidated_at >= observed_at)
  ),
  CONSTRAINT platform_microsoft_snapshot_time_valid CHECK (updated_at >= observed_at)
);

CREATE INDEX platform_microsoft_snapshot_connection_idx
  ON platform_microsoft_fleet_snapshots (connection_state, tenant_id);

CREATE TABLE platform_microsoft_fleet_capabilities (
  tenant_id UUID NOT NULL REFERENCES platform_microsoft_fleet_snapshots(tenant_id) ON DELETE CASCADE,
  capability VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  reason_code VARCHAR(96),
  checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  fresh_until TIMESTAMPTZ,
  incident_scope VARCHAR(16) NOT NULL,
  PRIMARY KEY (tenant_id, capability),
  CONSTRAINT platform_microsoft_capability_valid CHECK (capability IN ('places', 'free_busy', 'calendar_write')),
  CONSTRAINT platform_microsoft_capability_status_valid CHECK (status IN (
    'healthy', 'degraded', 'unavailable', 'revoked',
    'permission_missing', 'not_configured', 'unknown'
  )),
  CONSTRAINT platform_microsoft_capability_reason_valid CHECK (
    reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_.-]{0,95}$'
  ),
  CONSTRAINT platform_microsoft_capability_time_valid CHECK (
    (last_success_at IS NULL OR checked_at IS NOT NULL AND last_success_at <= checked_at)
    AND (fresh_until IS NULL OR checked_at IS NOT NULL AND fresh_until >= checked_at)
  ),
  CONSTRAINT platform_microsoft_capability_incident_valid CHECK (
    incident_scope IN ('provider', 'tenant', 'unknown')
  )
);

CREATE INDEX platform_microsoft_capability_filter_idx
  ON platform_microsoft_fleet_capabilities (capability, status, incident_scope, tenant_id);

CREATE TABLE microsoft365_room_discovery_observations (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  integration_id UUID NOT NULL,
  external_room_id VARCHAR(512) NOT NULL,
  resource_address VARCHAR(320) NOT NULL,
  provider_display_name VARCHAR(512) NOT NULL,
  provider_capacity INTEGER,
  provider_status VARCHAR(16) NOT NULL,
  connection_version BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  fresh_until TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, integration_id, external_room_id),
  CONSTRAINT microsoft365_room_observation_integration_fk
    FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT microsoft365_room_observation_values_valid CHECK (
    char_length(external_room_id) BETWEEN 1 AND 512
    AND char_length(resource_address) BETWEEN 1 AND 320
    AND char_length(provider_display_name) BETWEEN 1 AND 512
    AND provider_capacity IS NULL OR provider_capacity BETWEEN 0 AND 1000000
  ),
  CONSTRAINT microsoft365_room_observation_status_valid CHECK (
    provider_status IN ('active', 'inactive')
  ),
  CONSTRAINT microsoft365_room_observation_version_valid CHECK (
    connection_version >= 1 AND revision >= 1
  ),
  CONSTRAINT microsoft365_room_observation_freshness_valid CHECK (
    fresh_until > observed_at AND fresh_until <= observed_at + INTERVAL '24 hours'
  )
);

CREATE INDEX microsoft365_room_observation_repair_idx
  ON microsoft365_room_discovery_observations (
    tenant_id, integration_id, resource_address, fresh_until, external_room_id
  );

CREATE FUNCTION protect_microsoft365_room_discovery_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF ROW(NEW.tenant_id, NEW.integration_id, NEW.external_room_id)
     IS DISTINCT FROM ROW(OLD.tenant_id, OLD.integration_id, OLD.external_room_id)
     OR NEW.revision <> OLD.revision + 1
     OR NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'MICROSOFT365_ROOM_OBSERVATION_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER microsoft365_room_discovery_observations_revision_guard
BEFORE UPDATE OR DELETE ON microsoft365_room_discovery_observations
FOR EACH ROW EXECUTE FUNCTION protect_microsoft365_room_discovery_observation();

CREATE TABLE platform_diagnostic_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  correlation_id UUID NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'operation',
  action VARCHAR(96) NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  category VARCHAR(96),
  target_type VARCHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_diagnostic_event_source_valid CHECK (
    source IN ('tenant_audit', 'platform_audit', 'operation')
  ),
  CONSTRAINT platform_diagnostic_event_action_valid CHECK (action ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  CONSTRAINT platform_diagnostic_event_outcome_valid CHECK (outcome IN ('success', 'failure', 'denied', 'unknown')),
  CONSTRAINT platform_diagnostic_event_category_valid CHECK (
    category IS NULL OR category ~ '^[a-z][a-z0-9_.-]{0,95}$'
  ),
  CONSTRAINT platform_diagnostic_event_target_valid CHECK (
    target_type IS NULL OR target_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'
  ),
  CONSTRAINT platform_diagnostic_event_retention_valid CHECK (
    retain_until >= occurred_at + INTERVAL '90 days'
  )
);

CREATE INDEX platform_diagnostic_event_correlation_idx
  ON platform_diagnostic_events (tenant_id, correlation_id, occurred_at DESC, id DESC);
CREATE INDEX platform_diagnostic_event_failures_idx
  ON platform_diagnostic_events (tenant_id, occurred_at DESC, id DESC)
  WHERE outcome = 'failure';
CREATE INDEX platform_diagnostic_event_retention_idx
  ON platform_diagnostic_events (retain_until);

CREATE FUNCTION project_tenant_audit_diagnostic_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO platform_diagnostic_events (
    tenant_id, correlation_id, source, action, outcome, category,
    target_type, occurred_at, retain_until
  ) VALUES (
    NEW.tenant_id, NEW.correlation_id, 'tenant_audit', NEW.action, NEW.outcome,
    NULL, NEW.target_type, NEW.occurred_at,
    platform_add_utc_months(NEW.occurred_at, 24)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_diagnostic_projection
AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION project_tenant_audit_diagnostic_event();

CREATE FUNCTION project_platform_audit_diagnostic_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_tenant_id IS NOT NULL THEN
    INSERT INTO platform_diagnostic_events (
      tenant_id, correlation_id, source, action, outcome, category,
      target_type, occurred_at, retain_until
    ) VALUES (
      NEW.target_tenant_id, NEW.correlation_id, 'platform_audit', NEW.action, NEW.outcome,
      NULL, NEW.target_type, NEW.occurred_at,
      platform_add_utc_months(NEW.occurred_at, 24)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_audit_events_diagnostic_projection
AFTER INSERT ON platform_audit_events
FOR EACH ROW EXECUTE FUNCTION project_platform_audit_diagnostic_event();

CREATE TABLE platform_recovery_contexts (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  platform_session_id UUID REFERENCES platform_sessions(id) ON DELETE RESTRICT,
  break_glass_grant_id UUID REFERENCES platform_break_glass_grants(id) ON DELETE RESTRICT,
  operator_security_version BIGINT NOT NULL,
  security_epoch BIGINT,
  assurance_level VARCHAR(16) NOT NULL,
  authenticated_at TIMESTAMPTZ NOT NULL,
  operation VARCHAR(96) NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_id UUID NOT NULL,
  state_binding JSONB NOT NULL,
  impact_codes TEXT[] NOT NULL,
  correlation_id UUID NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  retain_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_recovery_context_authority_valid CHECK (
    (platform_session_id IS NOT NULL AND break_glass_grant_id IS NULL
      AND assurance_level IN ('mfa', 'step_up') AND security_epoch >= 1)
    OR (platform_session_id IS NULL AND break_glass_grant_id IS NOT NULL
      AND assurance_level = 'break_glass' AND security_epoch IS NULL)
  ),
  CONSTRAINT platform_recovery_context_security_version_valid CHECK (operator_security_version >= 1),
  CONSTRAINT platform_recovery_context_operation_valid CHECK (operation IN (
    'tenant.recovery.last_admin',
    'tenant.recovery.microsoft_reconsent',
    'tenant.recovery.room_mapping',
    'tenant.recovery.identity_unbind',
    'tenant.recovery.tenant_sessions',
    'tenant.recovery.user_sessions',
    'tenant.recovery.suspend',
    'tenant.recovery.reactivate'
  )),
  CONSTRAINT platform_recovery_context_state_valid CHECK (
    jsonb_typeof(state_binding) = 'object' AND octet_length(state_binding::TEXT) <= 8192
  ),
  CONSTRAINT platform_recovery_context_impact_valid CHECK (
    cardinality(impact_codes) BETWEEN 1 AND 16 AND array_position(impact_codes, NULL) IS NULL
  ),
  CONSTRAINT platform_recovery_context_expiry_valid CHECK (
    expires_at > issued_at AND expires_at <= issued_at + INTERVAL '15 minutes'
  ),
  CONSTRAINT platform_recovery_context_use_valid CHECK (
    used_at IS NULL OR used_at >= issued_at
  ),
  CONSTRAINT platform_recovery_context_retention_valid CHECK (
    retain_until >= platform_add_utc_months(expires_at, 24)
  )
);

CREATE INDEX platform_recovery_context_active_idx
  ON platform_recovery_contexts (operator_id, tenant_id, expires_at)
  WHERE used_at IS NULL;
CREATE INDEX platform_recovery_context_retention_idx
  ON platform_recovery_contexts (retain_until);

CREATE TABLE platform_microsoft_reconsent_handoffs (
  id UUID PRIMARY KEY,
  recovery_context_id UUID NOT NULL UNIQUE
    REFERENCES platform_recovery_contexts(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  integration_id UUID NOT NULL,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  retain_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_reconsent_handoff_integration_fk
    FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT platform_reconsent_handoff_expiry_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + INTERVAL '24 hours'
  ),
  CONSTRAINT platform_reconsent_handoff_consumption_valid CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT platform_reconsent_handoff_retention_valid CHECK (
    retain_until >= platform_add_utc_months(expires_at, 24)
  )
);

CREATE UNIQUE INDEX platform_reconsent_handoff_active_idx
  ON platform_microsoft_reconsent_handoffs (tenant_id, integration_id)
  WHERE consumed_at IS NULL;

CREATE FUNCTION protect_platform_operational_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.revision <> OLD.revision + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PLATFORM_OPERATIONAL_PROJECTION_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_readiness_snapshots_revision_guard
BEFORE UPDATE OR DELETE ON platform_tenant_readiness_snapshots
FOR EACH ROW EXECUTE FUNCTION protect_platform_operational_projection();
CREATE FUNCTION protect_platform_readiness_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_READINESS_EVIDENCE_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER platform_readiness_evidence_immutable
BEFORE UPDATE OR DELETE ON platform_tenant_readiness_evidence
FOR EACH ROW EXECUTE FUNCTION protect_platform_readiness_evidence();
CREATE TRIGGER platform_microsoft_snapshots_revision_guard
BEFORE UPDATE OR DELETE ON platform_microsoft_fleet_snapshots
FOR EACH ROW EXECUTE FUNCTION protect_platform_operational_projection();

CREATE FUNCTION invalidate_platform_tenant_operational_snapshots()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalidated_at_value TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision
     OR NEW.entitlement_revision IS DISTINCT FROM OLD.entitlement_revision THEN
    UPDATE platform_tenant_readiness_snapshots
    SET readiness_state = 'stale',
        blocker_codes = ARRAY(
          SELECT DISTINCT code
          FROM unnest(blocker_codes || ARRAY['snapshot.invalidated']::TEXT[]) AS code
          ORDER BY code
        ),
        invalidated_at = invalidated_at_value,
        invalidation_reason = 'tenant_state_changed',
        revision = revision + 1,
        updated_at = invalidated_at_value
    WHERE tenant_id = NEW.id AND invalidated_at IS NULL;

    UPDATE platform_microsoft_fleet_snapshots
    SET invalidated_at = invalidated_at_value,
        invalidation_reason = 'tenant_state_changed',
        revision = revision + 1,
        updated_at = invalidated_at_value
    WHERE tenant_id = NEW.id AND invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_invalidate_platform_operational_snapshots
AFTER UPDATE OF lifecycle_revision, entitlement_revision ON tenants
FOR EACH ROW EXECUTE FUNCTION invalidate_platform_tenant_operational_snapshots();

CREATE FUNCTION protect_platform_diagnostic_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PLATFORM_DIAGNOSTIC_EVENT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF clock_timestamp() < OLD.retain_until THEN
    RAISE EXCEPTION 'PLATFORM_DIAGNOSTIC_EVENT_RETAINED' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER platform_diagnostic_events_protected
BEFORE UPDATE OR DELETE ON platform_diagnostic_events
FOR EACH ROW EXECUTE FUNCTION protect_platform_diagnostic_event();

CREATE FUNCTION protect_platform_recovery_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF clock_timestamp() < OLD.retain_until THEN
      RAISE EXCEPTION 'PLATFORM_RECOVERY_CONTEXT_RETAINED' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.operator_id, NEW.platform_session_id, NEW.break_glass_grant_id,
         NEW.operator_security_version, NEW.security_epoch, NEW.assurance_level,
         NEW.authenticated_at, NEW.operation, NEW.tenant_id, NEW.target_id,
         NEW.state_binding, NEW.impact_codes, NEW.correlation_id, NEW.issued_at,
         NEW.expires_at, NEW.retain_until)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.operator_id, OLD.platform_session_id, OLD.break_glass_grant_id,
         OLD.operator_security_version, OLD.security_epoch, OLD.assurance_level,
         OLD.authenticated_at, OLD.operation, OLD.tenant_id, OLD.target_id,
         OLD.state_binding, OLD.impact_codes, OLD.correlation_id, OLD.issued_at,
         OLD.expires_at, OLD.retain_until)
     OR OLD.used_at IS NOT NULL
     OR NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_RECOVERY_CONTEXT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_recovery_contexts_protected
BEFORE UPDATE OR DELETE ON platform_recovery_contexts
FOR EACH ROW EXECUTE FUNCTION protect_platform_recovery_context();

CREATE FUNCTION protect_platform_reconsent_handoff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF clock_timestamp() < OLD.retain_until THEN
      RAISE EXCEPTION 'PLATFORM_RECONSENT_HANDOFF_RETAINED' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.recovery_context_id, NEW.tenant_id, NEW.integration_id,
         NEW.operator_id, NEW.created_at, NEW.expires_at, NEW.retain_until)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.recovery_context_id, OLD.tenant_id, OLD.integration_id,
         OLD.operator_id, OLD.created_at, OLD.expires_at, OLD.retain_until)
     OR OLD.consumed_at IS NOT NULL
     OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_RECONSENT_HANDOFF_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_reconsent_handoffs_protected
BEFORE UPDATE OR DELETE ON platform_microsoft_reconsent_handoffs
FOR EACH ROW EXECUTE FUNCTION protect_platform_reconsent_handoff();
