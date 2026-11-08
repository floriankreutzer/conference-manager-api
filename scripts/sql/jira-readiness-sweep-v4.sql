BEGIN;
CREATE TABLE cm_delivery.readiness_sweep_cursor (
  cloud_id uuid PRIMARY KEY,
  last_issue_key text NOT NULL CHECK (last_issue_key ~ '^CO-[1-9][0-9]{0,8}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON cm_delivery.readiness_sweep_cursor FROM PUBLIC;
COMMIT;
