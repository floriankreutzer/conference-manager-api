-- Explicit operational migration. Never run by either application runtime.
-- Execute as the dedicated integration schema owner, not an application role.
BEGIN;
CREATE SCHEMA cm_delivery;
REVOKE ALL ON SCHEMA cm_delivery FROM PUBLIC;
CREATE TABLE cm_delivery.register_journal (
  cloud_id uuid NOT NULL,
  issue_key text NOT NULL CHECK (issue_key ~ '^CO-[1-9][0-9]{0,8}$'),
  issue_id text NOT NULL CHECK (issue_id ~ '^[1-9][0-9]{0,19}$'),
  version integer NOT NULL CHECK (version > 0),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'confirmed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  PRIMARY KEY (cloud_id, issue_key, version),
  UNIQUE (cloud_id, issue_key, digest),
  CHECK ((state = 'pending' AND confirmed_at IS NULL) OR (state = 'confirmed' AND confirmed_at IS NOT NULL))
);
REVOKE ALL ON cm_delivery.register_journal FROM PUBLIC;
COMMIT;
