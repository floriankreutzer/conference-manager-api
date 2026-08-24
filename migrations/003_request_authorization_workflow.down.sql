ALTER TABLE requests
  DROP CONSTRAINT requests_status_changed_at_valid,
  DROP CONSTRAINT requests_status_reason_scope,
  DROP CONSTRAINT requests_status_reason_valid,
  DROP CONSTRAINT requests_status_valid,
  DROP COLUMN status_changed_at,
  DROP COLUMN status_reason;
