-- Explicit operational migration after v1/v2/v3. Never an application migration.
-- Run as the integration schema owner. The isolated writer needs SELECT/INSERT only.
-- Preserve this table and the original journal on rollback; disable the manual mode.
BEGIN;
CREATE TABLE cm_delivery.register_scope_revisions (
  cloud_id uuid NOT NULL,
  issue_key text NOT NULL,
  version integer NOT NULL CHECK (version > 1),
  previous_version integer NOT NULL CHECK (previous_version > 0 AND previous_version = version - 1),
  previous_digest text NOT NULL CHECK (previous_digest ~ '^[a-f0-9]{64}$'),
  comment_id text NOT NULL CHECK (comment_id ~ '^[1-9][0-9]{0,19}$'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[a-zA-Z0-9:-]{1,128}$'),
  comment_created_at timestamptz NOT NULL,
  decision_text text NOT NULL CHECK (octet_length(decision_text) BETWEEN 1 AND 16384),
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[a-f0-9]{64}$'),
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  workflow_run_id text NOT NULL CHECK (workflow_run_id ~ '^[1-9][0-9]{0,19}$'),
  workflow_run_attempt integer NOT NULL CHECK (workflow_run_attempt = 1),
  github_actor_id text NOT NULL CHECK (github_actor_id ~ '^[1-9][0-9]{0,19}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (cloud_id, issue_key, version),
  UNIQUE (cloud_id, issue_key, comment_id),
  UNIQUE (cloud_id, issue_key, decision_digest),
  FOREIGN KEY (cloud_id, issue_key, previous_version)
    REFERENCES cm_delivery.register_journal (cloud_id, issue_key, version),
  FOREIGN KEY (cloud_id, issue_key, version)
    REFERENCES cm_delivery.register_journal (cloud_id, issue_key, version)
);
REVOKE ALL ON cm_delivery.register_scope_revisions FROM PUBLIC;
COMMIT;
