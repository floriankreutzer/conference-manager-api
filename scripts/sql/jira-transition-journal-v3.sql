BEGIN;
CREATE TABLE cm_delivery.transition_journal (
  cloud_id uuid NOT NULL,
  issue_key text NOT NULL CHECK (issue_key ~ '^CO-[1-9][0-9]{0,8}$'),
  issue_id text NOT NULL CHECK (issue_id ~ '^[1-9][0-9]{0,19}$'),
  decision_key text NOT NULL CHECK (decision_key ~ '^[a-f0-9]{64}$'),
  attempt_id uuid NOT NULL,
  register_version integer NOT NULL CHECK (register_version > 0),
  register_digest text NOT NULL CHECK (register_digest ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[a-zA-Z0-9:-]{1,128}$'),
  transition_id text NOT NULL CHECK (transition_id ~ '^[1-9][0-9]{0,19}$'),
  source_status_id text NOT NULL CHECK (source_status_id ~ '^[1-9][0-9]{0,19}$'),
  target_status_id text NOT NULL CHECK (target_status_id ~ '^[1-9][0-9]{0,19}$'),
  issue_updated_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'confirmed')),
  history_id text CHECK (history_id ~ '^[1-9][0-9]{0,19}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  PRIMARY KEY (cloud_id, issue_key, decision_key),
  UNIQUE (cloud_id, attempt_id),
  UNIQUE (cloud_id, issue_key, history_id),
  FOREIGN KEY (cloud_id, issue_key, register_version)
    REFERENCES cm_delivery.register_journal (cloud_id, issue_key, version),
  CHECK (source_status_id <> target_status_id),
  CHECK ((state = 'pending' AND history_id IS NULL AND confirmed_at IS NULL)
    OR (state = 'confirmed' AND history_id IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX transition_journal_one_pending_per_issue
  ON cm_delivery.transition_journal (cloud_id, issue_key) WHERE state = 'pending';
REVOKE ALL ON cm_delivery.transition_journal FROM PUBLIC;
COMMIT;
