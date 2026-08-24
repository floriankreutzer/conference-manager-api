ALTER TABLE requests
  ADD COLUMN status_reason varchar(1000),
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT requests_status_valid CHECK (
    status IN ('Submitted', 'In Review', 'Confirmed', 'Rejected', 'Change Requested', 'Cancelled')
  ),
  ADD CONSTRAINT requests_status_reason_valid CHECK (
    status_reason IS NULL
    OR (
      char_length(status_reason) BETWEEN 1 AND 1000
      AND btrim(status_reason) = status_reason
    )
  ),
  ADD CONSTRAINT requests_status_reason_scope CHECK (
    status IN ('Rejected', 'Change Requested') OR status_reason IS NULL
  ),
  ADD CONSTRAINT requests_status_changed_at_valid CHECK (status_changed_at >= created_at);
