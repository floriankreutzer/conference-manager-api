CREATE TABLE booking_change_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id varchar(128) NOT NULL,
  initiator_user_id uuid NOT NULL,
  status varchar(16) NOT NULL,
  room_id varchar(128) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  internal_participants integer NOT NULL,
  external_participants integer NOT NULL,
  base_request_updated_at timestamptz NOT NULL,
  decided_by_user_id uuid,
  rejection_reason varchar(1000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT booking_change_request_fk
    FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_change_initiator_fk
    FOREIGN KEY (tenant_id, initiator_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_change_decider_fk
    FOREIGN KEY (tenant_id, decided_by_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_change_status_valid CHECK (status IN ('pending', 'applying', 'applied', 'rejected')),
  CONSTRAINT booking_change_window_valid CHECK (ends_at > starts_at),
  CONSTRAINT booking_change_participants_valid CHECK (
    internal_participants >= 0 AND external_participants >= 0
    AND internal_participants + external_participants >= 1
  ),
  CONSTRAINT booking_change_rejection_valid CHECK (
    (status = 'rejected' AND rejection_reason IS NOT NULL AND decided_by_user_id IS NOT NULL)
    OR (status <> 'rejected' AND rejection_reason IS NULL)
  ),
  CONSTRAINT booking_change_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX booking_change_one_open_per_request_idx
  ON booking_change_requests (tenant_id, request_id)
  WHERE status IN ('pending', 'applying');

CREATE INDEX booking_change_request_history_idx
  ON booking_change_requests (tenant_id, request_id, created_at DESC);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'session.issued', 'session.revoked', 'session.rotated', 'authentication.failed',
    'authorization.denied', 'request.created', 'request.transition',
    'request.transition_failed', 'request.booking_change',
    'tenant.configuration.changed', 'tenant.user_permissions.changed',
    'tenant.entitlement.changed', 'tenant.lifecycle.changed', 'tenant.onboarding.invited',
    'tenant.identity.claimed', 'tenant.identity.unbound', 'tenant.user.provisioned',
    'tenant.user.profile_updated', 'integration.connected', 'integration.disconnected',
    'integration.admin_consent.changed', 'integration.verified', 'calendar.operation', 'audit.read'
  )
);
