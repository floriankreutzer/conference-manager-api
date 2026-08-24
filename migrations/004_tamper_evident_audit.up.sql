DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_events LIMIT 1) THEN
    RAISE EXCEPTION 'AUDIT_LEGACY_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE audit_events
  ADD COLUMN previous_state jsonb,
  ADD COLUMN new_state jsonb,
  ADD COLUMN retention_class varchar(32) NOT NULL,
  ADD COLUMN previous_hash char(64),
  ADD COLUMN event_hash char(64) NOT NULL,
  ADD COLUMN integrity_version smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT audit_events_action_valid CHECK (
    action IN (
      'session.issued',
      'session.revoked',
      'session.rotated',
      'authentication.failed',
      'authorization.denied',
      'request.transition',
      'request.transition_failed',
      'tenant.configuration.changed',
      'tenant.user_permissions.changed',
      'integration.connected',
      'integration.disconnected',
      'integration.admin_consent.changed',
      'calendar.operation',
      'audit.read'
    )
  ),
  ADD CONSTRAINT audit_events_target_type_valid CHECK (
    target_type ~ '^[a-z][a-z0-9_:-]{0,63}$'
  ),
  ADD CONSTRAINT audit_events_target_id_valid CHECK (
    target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  ADD CONSTRAINT audit_events_previous_state_object CHECK (
    previous_state IS NULL OR jsonb_typeof(previous_state) = 'object'
  ),
  ADD CONSTRAINT audit_events_new_state_object CHECK (
    new_state IS NULL OR jsonb_typeof(new_state) = 'object'
  ),
  ADD CONSTRAINT audit_events_state_size_valid CHECK (
    (previous_state IS NULL OR octet_length(previous_state::text) <= 8192)
    AND (new_state IS NULL OR octet_length(new_state::text) <= 8192)
  ),
  ADD CONSTRAINT audit_events_metadata_size_valid CHECK (
    octet_length(metadata::text) <= 8192
  ),
  ADD CONSTRAINT audit_events_retention_class_valid CHECK (
    retention_class IN ('security', 'business', 'administrative')
  ),
  ADD CONSTRAINT audit_events_previous_hash_valid CHECK (
    previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT audit_events_event_hash_valid CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT audit_events_integrity_version_valid CHECK (integrity_version = 1),
  ADD CONSTRAINT audit_events_outcome_valid CHECK (outcome IN ('success', 'failure', 'denied'));

CREATE UNIQUE INDEX audit_events_tenant_hash_idx ON audit_events (tenant_id, event_hash);
CREATE INDEX audit_events_tenant_correlation_idx ON audit_events (tenant_id, correlation_id);

CREATE FUNCTION reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_EVENTS_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION reject_audit_event_mutation();
