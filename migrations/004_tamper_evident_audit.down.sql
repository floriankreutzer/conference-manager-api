DROP TRIGGER audit_events_append_only ON audit_events;
DROP FUNCTION reject_audit_event_mutation();
DROP INDEX audit_events_tenant_correlation_idx;
DROP INDEX audit_events_tenant_hash_idx;

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_outcome_valid,
  DROP CONSTRAINT audit_events_integrity_version_valid,
  DROP CONSTRAINT audit_events_event_hash_valid,
  DROP CONSTRAINT audit_events_previous_hash_valid,
  DROP CONSTRAINT audit_events_retention_class_valid,
  DROP CONSTRAINT audit_events_metadata_size_valid,
  DROP CONSTRAINT audit_events_state_size_valid,
  DROP CONSTRAINT audit_events_new_state_object,
  DROP CONSTRAINT audit_events_previous_state_object,
  DROP CONSTRAINT audit_events_target_id_valid,
  DROP CONSTRAINT audit_events_target_type_valid,
  DROP CONSTRAINT audit_events_action_valid,
  DROP COLUMN integrity_version,
  DROP COLUMN event_hash,
  DROP COLUMN previous_hash,
  DROP COLUMN retention_class,
  DROP COLUMN new_state,
  DROP COLUMN previous_state;
