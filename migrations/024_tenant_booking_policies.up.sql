CREATE TABLE tenant_booking_policies (
  tenant_id uuid PRIMARY KEY,
  min_notice_minutes integer NOT NULL,
  max_advance_days integer NOT NULL,
  max_duration_minutes integer NOT NULL,
  max_participants integer NOT NULL,
  allow_external_participants boolean NOT NULL,
  cancellation_cutoff_minutes integer NOT NULL,
  change_cutoff_minutes integer NOT NULL,
  effective_from timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT tenant_booking_policies_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_booking_policies_min_notice_valid CHECK (min_notice_minutes BETWEEN 0 AND 525600),
  CONSTRAINT tenant_booking_policies_max_advance_valid CHECK (max_advance_days BETWEEN 1 AND 730),
  CONSTRAINT tenant_booking_policies_duration_valid CHECK (max_duration_minutes BETWEEN 15 AND 10080),
  CONSTRAINT tenant_booking_policies_participants_valid CHECK (max_participants BETWEEN 1 AND 100000),
  CONSTRAINT tenant_booking_policies_cancel_cutoff_valid CHECK (cancellation_cutoff_minutes BETWEEN 0 AND 10080),
  CONSTRAINT tenant_booking_policies_change_cutoff_valid CHECK (change_cutoff_minutes BETWEEN 0 AND 10080)
);
