CREATE TABLE platform_audit_events (
  sequence BIGINT PRIMARY KEY,
  operator_id UUID REFERENCES platform_operators(id) ON DELETE RESTRICT,
  roles TEXT[] NOT NULL,
  permissions TEXT[] NOT NULL,
  assurance_level VARCHAR(16) NOT NULL,
  target_tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  action VARCHAR(96) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(128) NOT NULL,
  previous_state JSONB,
  new_state JSONB,
  occurred_at TIMESTAMPTZ NOT NULL,
  correlation_id UUID NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  retention_class VARCHAR(32) NOT NULL,
  previous_hash CHAR(64),
  event_hash CHAR(64) NOT NULL,
  integrity_version SMALLINT NOT NULL DEFAULT 1,
  CONSTRAINT platform_audit_sequence_hash_unique UNIQUE (sequence, event_hash),
  CONSTRAINT platform_audit_actor_snapshot_valid CHECK (
    (operator_id IS NULL
      AND action = 'platform.authentication.failed'
      AND cardinality(roles) = 0
      AND cardinality(permissions) = 0
      AND assurance_level = 'unverified')
    OR
    (operator_id IS NOT NULL
      AND platform_roles_are_canonical(roles)
      AND permissions = platform_permissions_for_roles(roles)
      AND assurance_level IN ('mfa', 'step_up', 'break_glass'))
  ),
  CONSTRAINT platform_audit_action_valid CHECK (action IN (
    'platform.authentication.succeeded',
    'platform.authentication.failed',
    'platform.authorization.denied',
    'platform.session.issued',
    'platform.session.rotated',
    'platform.session.revoked',
    'platform.session.epoch_rejected',
    'platform.break_glass.granted',
    'platform.break_glass.revoked',
    'platform.break_glass.used',
    'platform.break_glass.denied',
    'platform.tenant.directory.read',
    'platform.tenant.registration.changed',
    'platform.tenant.invitation.changed',
    'platform.tenant.lifecycle.changed',
    'platform.tenant.entitlement.changed',
    'platform.tenant.quota.changed',
    'platform.tenant.configuration.changed',
    'platform.tenant.integration.changed',
    'platform.tenant.readiness.read',
    'platform.diagnostics.read',
    'platform.metering.read',
    'platform.runtime.read',
    'platform.recovery.previewed',
    'platform.recovery.executed',
    'platform.audit.read',
    'platform.audit.exported',
    'platform.operator.changed'
  )),
  CONSTRAINT platform_audit_target_type_valid CHECK (target_type ~ '^[a-z][a-z0-9_:-]{0,63}$'),
  CONSTRAINT platform_audit_target_id_valid CHECK (target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT platform_audit_states_valid CHECK (
    (previous_state IS NULL OR (jsonb_typeof(previous_state) = 'object' AND octet_length(previous_state::TEXT) <= 8192))
    AND (new_state IS NULL OR (jsonb_typeof(new_state) = 'object' AND octet_length(new_state::TEXT) <= 8192))
  ),
  CONSTRAINT platform_audit_metadata_valid CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::TEXT) <= 8192
  ),
  CONSTRAINT platform_audit_outcome_valid CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT platform_audit_retention_valid CHECK (retention_class IN ('security', 'administrative', 'recovery')),
  CONSTRAINT platform_audit_previous_hash_valid CHECK (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_audit_event_hash_valid CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_audit_integrity_version_valid CHECK (integrity_version = 1)
);

CREATE INDEX platform_audit_operator_time_idx ON platform_audit_events (operator_id, occurred_at DESC);
CREATE INDEX platform_audit_tenant_time_idx ON platform_audit_events (target_tenant_id, occurred_at DESC);
CREATE INDEX platform_audit_correlation_idx ON platform_audit_events (correlation_id);

CREATE TABLE platform_audit_checkpoints (
  event_count BIGINT PRIMARY KEY,
  terminal_event_hash CHAR(64) NOT NULL,
  previous_checkpoint_hash CHAR(64),
  checkpoint_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  integrity_version SMALLINT NOT NULL DEFAULT 1,
  CONSTRAINT platform_audit_checkpoint_event_fk
    FOREIGN KEY (event_count, terminal_event_hash)
    REFERENCES platform_audit_events(sequence, event_hash) ON DELETE RESTRICT,
  CONSTRAINT platform_audit_checkpoint_previous_fk
    FOREIGN KEY (previous_checkpoint_hash)
    REFERENCES platform_audit_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
  CONSTRAINT platform_audit_checkpoint_interval_valid CHECK (event_count > 0 AND event_count % 32 = 0),
  CONSTRAINT platform_audit_checkpoint_terminal_hash_valid CHECK (terminal_event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_audit_checkpoint_previous_hash_valid
    CHECK (previous_checkpoint_hash IS NULL OR previous_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_audit_checkpoint_hash_valid CHECK (checkpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_audit_checkpoint_integrity_version_valid CHECK (integrity_version = 1)
);

CREATE TABLE platform_audit_chain_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  event_count BIGINT NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  terminal_event_hash CHAR(64),
  terminal_checkpoint_hash CHAR(64),
  CONSTRAINT platform_audit_chain_event_hash_valid
    CHECK (terminal_event_hash IS NULL OR terminal_event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_audit_chain_checkpoint_hash_valid
    CHECK (terminal_checkpoint_hash IS NULL OR terminal_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_audit_chain_empty_valid CHECK (
    (event_count = 0 AND terminal_event_hash IS NULL AND terminal_checkpoint_hash IS NULL)
    OR (event_count > 0 AND terminal_event_hash IS NOT NULL)
  )
);

INSERT INTO platform_audit_chain_state (singleton) VALUES (true);

CREATE FUNCTION reject_platform_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_AUDIT_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER platform_audit_events_append_only
BEFORE UPDATE OR DELETE ON platform_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_platform_audit_mutation();

CREATE TRIGGER platform_audit_checkpoints_append_only
BEFORE UPDATE OR DELETE ON platform_audit_checkpoints
FOR EACH ROW EXECUTE FUNCTION reject_platform_audit_mutation();
