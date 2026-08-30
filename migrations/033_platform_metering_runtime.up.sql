CREATE FUNCTION platform_metering_period_is_utc_month(period_start TIMESTAMPTZ, period_end TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    period_start = date_trunc('month', period_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND period_end = platform_add_utc_months(period_start, 1)
$$;

CREATE FUNCTION platform_runtime_support_identifier_is_valid(candidate TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT candidate IS NULL OR candidate ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$$;

CREATE FUNCTION platform_runtime_reference_is_valid(candidate TEXT, maximum_length INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT candidate IS NULL OR (
    char_length(candidate) BETWEEN 1 AND maximum_length
    AND candidate ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]*$'
    AND position('://' IN candidate) = 0
  )
$$;

CREATE TABLE platform_metering_events (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_event_key CHAR(64) NOT NULL,
  payload_digest CHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  dimension VARCHAR(64) NOT NULL,
  units BIGINT NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, source_event_key),
  CONSTRAINT platform_metering_event_key_valid CHECK (
    source_event_key ~ '^[0-9a-f]{64}$'
    AND payload_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT platform_metering_event_pair_valid CHECK (
    (event_type = 'request.created' AND dimension = 'requests_created')
    OR (event_type = 'booking.confirmed' AND dimension = 'bookings_confirmed')
    OR (
      event_type = 'integration.operation.completed'
      AND dimension = 'integration_operations'
    )
  ),
  CONSTRAINT platform_metering_event_units_valid CHECK (units = 1),
  CONSTRAINT platform_metering_event_period_valid CHECK (
    platform_metering_period_is_utc_month(period_start, period_end)
    AND occurred_at >= period_start
    AND occurred_at < period_end
    AND recorded_at >= occurred_at
    AND ingested_at >= occurred_at
  ),
  CONSTRAINT platform_metering_event_retention_valid CHECK (
    retain_until >= platform_add_utc_months(period_end, 24)
    AND retain_until >= platform_add_utc_months(recorded_at, 24)
    AND retain_until >= platform_add_utc_months(ingested_at, 24)
  )
);

CREATE INDEX platform_metering_events_period_dimension_idx
  ON platform_metering_events (tenant_id, period_start, dimension, ingested_at);
CREATE INDEX platform_metering_events_retention_idx
  ON platform_metering_events (retain_until);

CREATE TABLE platform_metering_periods (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  data_state VARCHAR(16) NOT NULL,
  measured_at TIMESTAMPTZ,
  event_watermark TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  active_users BIGINT,
  active_rooms BIGINT,
  requests_created BIGINT,
  bookings_confirmed BIGINT,
  integration_operations BIGINT,
  revision BIGINT NOT NULL DEFAULT 1,
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, period_start),
  CONSTRAINT platform_metering_period_bounds_valid CHECK (
    platform_metering_period_is_utc_month(period_start, period_end)
  ),
  CONSTRAINT platform_metering_period_values_valid CHECK (
    (active_users IS NULL OR active_users BETWEEN 0 AND 9007199254740991)
    AND (active_rooms IS NULL OR active_rooms BETWEEN 0 AND 9007199254740991)
    AND (requests_created IS NULL OR requests_created BETWEEN 0 AND 9007199254740991)
    AND (bookings_confirmed IS NULL OR bookings_confirmed BETWEEN 0 AND 9007199254740991)
    AND (
      integration_operations IS NULL
      OR integration_operations BETWEEN 0 AND 9007199254740991
    )
  ),
  CONSTRAINT platform_metering_period_state_valid CHECK (
    (
      data_state = 'complete'
      AND measured_at IS NOT NULL
      AND event_watermark IS NOT NULL
      AND active_users IS NOT NULL
      AND active_rooms IS NOT NULL
      AND requests_created IS NOT NULL
      AND bookings_confirmed IS NOT NULL
      AND integration_operations IS NOT NULL
    )
    OR (
      data_state = 'partial'
      AND measured_at IS NOT NULL
      AND event_watermark IS NOT NULL
      AND num_nonnulls(
        active_users,
        active_rooms,
        requests_created,
        bookings_confirmed,
        integration_operations
      ) > 0
    )
    OR (
      data_state = 'unknown'
      AND measured_at IS NULL
      AND event_watermark IS NULL
      AND num_nonnulls(
        active_users,
        active_rooms,
        requests_created,
        bookings_confirmed,
        integration_operations
      ) = 0
    )
  ),
  CONSTRAINT platform_metering_period_watermark_valid CHECK (
    event_watermark IS NULL
    OR (
      event_watermark <= measured_at
      AND (reconciled_at IS NULL OR measured_at <= reconciled_at)
    )
  ),
  CONSTRAINT platform_metering_period_revision_valid CHECK (revision >= 1),
  CONSTRAINT platform_metering_period_retention_valid CHECK (
    retain_until >= platform_add_utc_months(period_end, 24)
    AND retain_until >= platform_add_utc_months(
      COALESCE(reconciled_at, measured_at, period_end), 24
    )
  )
);

CREATE INDEX platform_metering_periods_state_idx
  ON platform_metering_periods (tenant_id, data_state, period_start DESC);
CREATE INDEX platform_metering_periods_retention_idx
  ON platform_metering_periods (retain_until);

CREATE TABLE platform_metering_period_revisions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  data_state VARCHAR(16) NOT NULL,
  measured_at TIMESTAMPTZ,
  event_watermark TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  active_users BIGINT,
  active_rooms BIGINT,
  requests_created BIGINT,
  bookings_confirmed BIGINT,
  integration_operations BIGINT,
  revision BIGINT NOT NULL,
  original_retain_until TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, period_start, revision),
  CONSTRAINT platform_metering_period_revision_bounds_valid CHECK (
    platform_metering_period_is_utc_month(period_start, period_end)
  ),
  CONSTRAINT platform_metering_period_revision_values_valid CHECK (
    (active_users IS NULL OR active_users BETWEEN 0 AND 9007199254740991)
    AND (active_rooms IS NULL OR active_rooms BETWEEN 0 AND 9007199254740991)
    AND (requests_created IS NULL OR requests_created BETWEEN 0 AND 9007199254740991)
    AND (bookings_confirmed IS NULL OR bookings_confirmed BETWEEN 0 AND 9007199254740991)
    AND (
      integration_operations IS NULL
      OR integration_operations BETWEEN 0 AND 9007199254740991
    )
  ),
  CONSTRAINT platform_metering_period_revision_state_valid CHECK (
    (
      data_state = 'complete'
      AND measured_at IS NOT NULL
      AND event_watermark IS NOT NULL
      AND active_users IS NOT NULL
      AND active_rooms IS NOT NULL
      AND requests_created IS NOT NULL
      AND bookings_confirmed IS NOT NULL
      AND integration_operations IS NOT NULL
    )
    OR (
      data_state = 'partial'
      AND measured_at IS NOT NULL
      AND event_watermark IS NOT NULL
      AND num_nonnulls(
        active_users,
        active_rooms,
        requests_created,
        bookings_confirmed,
        integration_operations
      ) > 0
    )
    OR (
      data_state = 'unknown'
      AND measured_at IS NULL
      AND event_watermark IS NULL
      AND num_nonnulls(
        active_users,
        active_rooms,
        requests_created,
        bookings_confirmed,
        integration_operations
      ) = 0
    )
  ),
  CONSTRAINT platform_metering_period_revision_watermark_valid CHECK (
    event_watermark IS NULL
    OR (
      event_watermark <= measured_at
      AND (reconciled_at IS NULL OR measured_at <= reconciled_at)
    )
  ),
  CONSTRAINT platform_metering_period_revision_number_valid CHECK (revision >= 1),
  CONSTRAINT platform_metering_period_revision_retention_valid CHECK (
    retain_until >= original_retain_until
    AND retain_until >= platform_add_utc_months(superseded_at, 24)
  )
);

CREATE INDEX platform_metering_period_revisions_retention_idx
  ON platform_metering_period_revisions (retain_until);

CREATE TABLE platform_operational_quotas (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  dimension VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL,
  soft_limit BIGINT,
  hard_limit BIGINT,
  revision BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, dimension),
  CONSTRAINT platform_operational_quota_dimension_valid CHECK (dimension IN (
    'active_users',
    'active_rooms',
    'requests_created',
    'bookings_confirmed',
    'integration_operations'
  )),
  CONSTRAINT platform_operational_quota_limits_valid CHECK (
    (soft_limit IS NULL OR soft_limit BETWEEN 0 AND 9007199254740991)
    AND (hard_limit IS NULL OR hard_limit BETWEEN 0 AND 9007199254740991)
    AND (soft_limit IS NULL OR hard_limit IS NULL OR soft_limit <= hard_limit)
  ),
  CONSTRAINT platform_operational_quota_state_valid CHECK (
    (state = 'configured' AND num_nonnulls(soft_limit, hard_limit) > 0)
    OR (state = 'not_configured' AND soft_limit IS NULL AND hard_limit IS NULL)
  ),
  CONSTRAINT platform_operational_quota_revision_valid CHECK (revision >= 1)
);

CREATE INDEX platform_operational_quotas_state_idx
  ON platform_operational_quotas (tenant_id, state, dimension);

CREATE TABLE platform_quota_operation_receipts (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  operator_id UUID NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  request_digest CHAR(64) NOT NULL,
  dimension VARCHAR(64) NOT NULL,
  result_state VARCHAR(32) NOT NULL,
  result_soft_limit BIGINT,
  result_hard_limit BIGINT,
  result_revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retain_until TIMESTAMPTZ NOT NULL DEFAULT (
    platform_add_utc_months(clock_timestamp(), 24) + INTERVAL '1 second'
  ),
  PRIMARY KEY (tenant_id, idempotency_key),
  CONSTRAINT platform_quota_receipt_revision_unique
    UNIQUE (tenant_id, dimension, result_revision),
  CONSTRAINT platform_quota_receipt_digest_valid
    CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_quota_receipt_dimension_valid CHECK (dimension IN (
    'active_users',
    'active_rooms',
    'requests_created',
    'bookings_confirmed',
    'integration_operations'
  )),
  CONSTRAINT platform_quota_receipt_limits_valid CHECK (
    (result_soft_limit IS NULL OR result_soft_limit BETWEEN 0 AND 9007199254740991)
    AND (result_hard_limit IS NULL OR result_hard_limit BETWEEN 0 AND 9007199254740991)
    AND (
      result_soft_limit IS NULL
      OR result_hard_limit IS NULL
      OR result_soft_limit <= result_hard_limit
    )
  ),
  CONSTRAINT platform_quota_receipt_state_valid CHECK (
    (
      result_state = 'configured'
      AND num_nonnulls(result_soft_limit, result_hard_limit) > 0
    )
    OR (
      result_state = 'not_configured'
      AND result_soft_limit IS NULL
      AND result_hard_limit IS NULL
    )
  ),
  CONSTRAINT platform_quota_receipt_revision_valid CHECK (result_revision >= 1),
  CONSTRAINT platform_quota_receipt_retention_valid CHECK (
    retain_until >= platform_add_utc_months(created_at, 24)
  )
);

CREATE INDEX platform_quota_operation_receipts_retention_idx
  ON platform_quota_operation_receipts (retain_until);

CREATE TABLE platform_runtime_deployments (
  id UUID PRIMARY KEY,
  environment VARCHAR(16) NOT NULL,
  deployment_reference VARCHAR(128) NOT NULL,
  deployed_at TIMESTAMPTZ NOT NULL,
  frontend_environment VARCHAR(16) NOT NULL,
  frontend_deployment_reference VARCHAR(128),
  frontend_expected_version VARCHAR(64),
  frontend_expected_build_id VARCHAR(64),
  frontend_version VARCHAR(64),
  frontend_build_id VARCHAR(64),
  api_environment VARCHAR(16) NOT NULL,
  api_deployment_reference VARCHAR(128),
  api_expected_version VARCHAR(64),
  api_expected_build_id VARCHAR(64),
  api_version VARCHAR(64),
  api_build_id VARCHAR(64),
  schema_environment VARCHAR(16) NOT NULL,
  schema_deployment_reference VARCHAR(128),
  schema_expected_version INTEGER,
  schema_current_version INTEGER,
  dependencies_environment VARCHAR(16) NOT NULL,
  dependencies_deployment_reference VARCHAR(128),
  required_dependencies_state VARCHAR(16) NOT NULL DEFAULT 'unknown',
  optional_dependencies_state VARCHAR(16) NOT NULL DEFAULT 'unknown',
  observed_at TIMESTAMPTZ,
  release_evidence_reference VARCHAR(255),
  change_evidence_reference VARCHAR(255),
  rollback_evidence_reference VARCHAR(255),
  runbook_evidence_reference VARCHAR(255),
  record_state VARCHAR(16) NOT NULL DEFAULT 'approved',
  revision BIGINT NOT NULL DEFAULT 1,
  retain_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_runtime_deployment_identity_unique
    UNIQUE (environment, deployment_reference),
  CONSTRAINT platform_runtime_deployment_environment_valid CHECK (
    environment IN ('development', 'test', 'pilot', 'production')
    AND frontend_environment IN ('development', 'test', 'pilot', 'production')
    AND api_environment IN ('development', 'test', 'pilot', 'production')
    AND schema_environment IN ('development', 'test', 'pilot', 'production')
    AND dependencies_environment IN ('development', 'test', 'pilot', 'production')
  ),
  CONSTRAINT platform_runtime_deployment_references_valid CHECK (
    platform_runtime_reference_is_valid(deployment_reference, 128)
    AND platform_runtime_reference_is_valid(frontend_deployment_reference, 128)
    AND platform_runtime_reference_is_valid(api_deployment_reference, 128)
    AND platform_runtime_reference_is_valid(schema_deployment_reference, 128)
    AND platform_runtime_reference_is_valid(dependencies_deployment_reference, 128)
  ),
  CONSTRAINT platform_runtime_deployment_components_valid CHECK (
    platform_runtime_support_identifier_is_valid(frontend_expected_version)
    AND platform_runtime_support_identifier_is_valid(frontend_expected_build_id)
    AND platform_runtime_support_identifier_is_valid(frontend_version)
    AND platform_runtime_support_identifier_is_valid(frontend_build_id)
    AND platform_runtime_support_identifier_is_valid(api_expected_version)
    AND platform_runtime_support_identifier_is_valid(api_expected_build_id)
    AND platform_runtime_support_identifier_is_valid(api_version)
    AND platform_runtime_support_identifier_is_valid(api_build_id)
  ),
  CONSTRAINT platform_runtime_deployment_schema_valid CHECK (
    schema_expected_version IS NULL
    OR schema_expected_version BETWEEN 1 AND 100000
  ),
  CONSTRAINT platform_runtime_deployment_current_schema_valid CHECK (
    schema_current_version IS NULL
    OR schema_current_version BETWEEN 0 AND 100000
  ),
  CONSTRAINT platform_runtime_deployment_dependencies_valid CHECK (
    required_dependencies_state IN ('ready', 'not_ready', 'unknown')
    AND optional_dependencies_state IN ('ready', 'degraded', 'unknown')
  ),
  CONSTRAINT platform_runtime_deployment_evidence_valid CHECK (
    platform_runtime_reference_is_valid(release_evidence_reference, 255)
    AND platform_runtime_reference_is_valid(change_evidence_reference, 255)
    AND platform_runtime_reference_is_valid(rollback_evidence_reference, 255)
    AND platform_runtime_reference_is_valid(runbook_evidence_reference, 255)
  ),
  CONSTRAINT platform_runtime_deployment_state_valid CHECK (
    (record_state = 'approved' AND retain_until IS NULL)
    OR (
      record_state = 'superseded'
      AND retain_until IS NOT NULL
      AND retain_until >= platform_add_utc_months(updated_at, 24)
    )
  ),
  CONSTRAINT platform_runtime_deployment_revision_valid CHECK (revision >= 1)
);

CREATE INDEX platform_runtime_deployments_approved_idx
  ON platform_runtime_deployments (environment, deployed_at DESC, deployment_reference)
  WHERE record_state = 'approved';
CREATE INDEX platform_runtime_deployments_observation_idx
  ON platform_runtime_deployments (observed_at)
  WHERE record_state = 'approved';
CREATE INDEX platform_runtime_deployments_retention_idx
  ON platform_runtime_deployments (retain_until)
  WHERE retain_until IS NOT NULL;

CREATE TABLE platform_runtime_tenant_mappings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  deployment_id UUID NOT NULL REFERENCES platform_runtime_deployments(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL DEFAULT 1,
  mapped_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_runtime_tenant_mapping_revision_valid CHECK (revision >= 1)
);

CREATE INDEX platform_runtime_tenant_mappings_deployment_idx
  ON platform_runtime_tenant_mappings (deployment_id, tenant_id);

CREATE FUNCTION protect_platform_metering_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PLATFORM_METERING_EVENT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF clock_timestamp() < OLD.retain_until THEN
    RAISE EXCEPTION 'PLATFORM_METERING_EVENT_RETAINED' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER platform_metering_events_protected
BEFORE UPDATE OR DELETE ON platform_metering_events
FOR EACH ROW EXECUTE FUNCTION protect_platform_metering_event();

CREATE FUNCTION protect_platform_metering_period_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PLATFORM_METERING_PERIOD_REVISION_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF clock_timestamp() < OLD.retain_until THEN
    RAISE EXCEPTION 'PLATFORM_METERING_PERIOD_REVISION_RETAINED' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER platform_metering_period_revisions_protected
BEFORE UPDATE OR DELETE ON platform_metering_period_revisions
FOR EACH ROW EXECUTE FUNCTION protect_platform_metering_period_revision();

CREATE FUNCTION protect_platform_metering_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF clock_timestamp() < OLD.retain_until THEN
      RAISE EXCEPTION 'PLATFORM_METERING_PERIOD_RETAINED' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.tenant_id, NEW.period_start, NEW.period_end)
     IS DISTINCT FROM ROW(OLD.tenant_id, OLD.period_start, OLD.period_end)
     OR NEW.revision <> OLD.revision + 1
     OR NEW.retain_until < OLD.retain_until
     OR (
       OLD.event_watermark IS NOT NULL
       AND (
         NEW.event_watermark IS NULL
         OR NEW.event_watermark < OLD.event_watermark
       )
     )
     OR (
       OLD.reconciled_at IS NOT NULL
       AND (
         NEW.reconciled_at IS NULL
         OR NEW.reconciled_at < OLD.reconciled_at
       )
     ) THEN
    RAISE EXCEPTION 'PLATFORM_METERING_PERIOD_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  INSERT INTO platform_metering_period_revisions (
    tenant_id,
    period_start,
    period_end,
    data_state,
    measured_at,
    event_watermark,
    reconciled_at,
    active_users,
    active_rooms,
    requests_created,
    bookings_confirmed,
    integration_operations,
    revision,
    original_retain_until,
    superseded_at,
    retain_until
  )
  VALUES (
    OLD.tenant_id,
    OLD.period_start,
    OLD.period_end,
    OLD.data_state,
    OLD.measured_at,
    OLD.event_watermark,
    OLD.reconciled_at,
    OLD.active_users,
    OLD.active_rooms,
    OLD.requests_created,
    OLD.bookings_confirmed,
    OLD.integration_operations,
    OLD.revision,
    OLD.retain_until,
    date_trunc('milliseconds', clock_timestamp()),
    GREATEST(
      OLD.retain_until,
      platform_add_utc_months(date_trunc('milliseconds', clock_timestamp()), 24)
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_metering_periods_protected
BEFORE UPDATE OR DELETE ON platform_metering_periods
FOR EACH ROW EXECUTE FUNCTION protect_platform_metering_period();

CREATE FUNCTION protect_platform_operational_quota()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLATFORM_OPERATIONAL_QUOTA_HISTORY_REQUIRED' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.tenant_id, NEW.dimension) IS DISTINCT FROM ROW(OLD.tenant_id, OLD.dimension)
     OR NEW.revision <> OLD.revision + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PLATFORM_OPERATIONAL_QUOTA_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_operational_quotas_protected
BEFORE UPDATE OR DELETE ON platform_operational_quotas
FOR EACH ROW EXECUTE FUNCTION protect_platform_operational_quota();

CREATE FUNCTION protect_platform_quota_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PLATFORM_QUOTA_RECEIPT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF clock_timestamp() < OLD.retain_until THEN
    RAISE EXCEPTION 'PLATFORM_QUOTA_RECEIPT_RETAINED' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER platform_quota_operation_receipts_protected
BEFORE UPDATE OR DELETE ON platform_quota_operation_receipts
FOR EACH ROW EXECUTE FUNCTION protect_platform_quota_receipt();

CREATE FUNCTION protect_platform_runtime_deployment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.record_state <> 'superseded' OR clock_timestamp() < OLD.retain_until THEN
      RAISE EXCEPTION 'PLATFORM_RUNTIME_DEPLOYMENT_RETAINED' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.environment, NEW.deployment_reference, NEW.deployed_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.environment, OLD.deployment_reference, OLD.deployed_at)
     OR NEW.revision <> OLD.revision + 1
     OR NEW.updated_at < OLD.updated_at
     OR (
       NEW.record_state = 'superseded'
       AND EXISTS (
         SELECT 1 FROM platform_runtime_tenant_mappings mapping
         WHERE mapping.deployment_id = OLD.id
       )
     ) THEN
    RAISE EXCEPTION 'PLATFORM_RUNTIME_DEPLOYMENT_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_runtime_deployments_protected
BEFORE UPDATE OR DELETE ON platform_runtime_deployments
FOR EACH ROW EXECUTE FUNCTION protect_platform_runtime_deployment();

CREATE FUNCTION protect_platform_runtime_tenant_mapping()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deployment_state VARCHAR(16);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PLATFORM_RUNTIME_TENANT_MAPPING_HISTORY_REQUIRED' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id <> OLD.tenant_id
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at < OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'PLATFORM_RUNTIME_TENANT_MAPPING_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  SELECT record_state INTO deployment_state
  FROM platform_runtime_deployments
  WHERE id = NEW.deployment_id
  FOR KEY SHARE;
  IF deployment_state IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'PLATFORM_RUNTIME_TENANT_MAPPING_TARGET_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_runtime_tenant_mappings_protected
BEFORE INSERT OR UPDATE OR DELETE ON platform_runtime_tenant_mappings
FOR EACH ROW EXECUTE FUNCTION protect_platform_runtime_tenant_mapping();
