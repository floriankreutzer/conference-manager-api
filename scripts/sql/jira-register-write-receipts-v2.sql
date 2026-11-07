-- Apply after jira-register-journal-v1.sql, explicitly as the integration schema owner.
-- Integration login: SELECT, INSERT, UPDATE(task_id) only. No runtime/customer grants.
BEGIN;
CREATE TABLE cm_delivery.register_write_receipts (
  cloud_id uuid NOT NULL,
  issue_key text NOT NULL,
  version integer NOT NULL,
  task_id text CHECK (task_id ~ '^[a-zA-Z0-9-]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (cloud_id, issue_key, version),
  UNIQUE (cloud_id, task_id),
  FOREIGN KEY (cloud_id, issue_key, version)
    REFERENCES cm_delivery.register_journal (cloud_id, issue_key, version)
);
REVOKE ALL ON cm_delivery.register_write_receipts FROM PUBLIC;
COMMIT;
