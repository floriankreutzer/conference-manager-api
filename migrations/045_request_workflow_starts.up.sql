-- Content-free editing lifecycle. The server reserves the future Request ID.
-- Browser draft text and browser clocks never enter this ledger.
CREATE TABLE request_workflow_starts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'started',
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  request_id varchar(128),
  submission_fingerprint char(64),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_user_id, idempotency_key),
  CONSTRAINT request_workflow_owner_fk FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT request_workflow_request_fk FOREIGN KEY (tenant_id, request_id)
    REFERENCES requests(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT request_workflow_state_valid CHECK (
    (status = 'started' AND ended_at IS NULL AND request_id IS NULL AND submission_fingerprint IS NULL)
    OR (status = 'abandoned' AND ended_at >= started_at AND request_id IS NULL AND submission_fingerprint IS NULL)
    OR (status = 'submitted' AND ended_at >= started_at AND request_id = id::text
      AND submission_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT request_workflow_terminal_time CHECK (status = 'started' OR ended_at IS NOT NULL),
  CONSTRAINT request_workflow_submission CHECK (
    status <> 'submitted' OR (request_id IS NOT NULL AND submission_fingerprint IS NOT NULL)
  )
);
REVOKE ALL ON TABLE request_workflow_starts FROM PUBLIC;

CREATE FUNCTION guard_request_workflow_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.owner_user_id, NEW.idempotency_key, NEW.started_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.owner_user_id, OLD.idempotency_key, OLD.started_at)
     OR OLD.status <> 'started' OR NEW.status NOT IN ('submitted', 'abandoned') THEN
    RAISE EXCEPTION 'REQUEST_WORKFLOW_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_request_workflow_transition() FROM PUBLIC;
CREATE TRIGGER request_workflow_transition_guard BEFORE UPDATE ON request_workflow_starts
  FOR EACH ROW EXECUTE FUNCTION guard_request_workflow_transition();

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'session.issued', 'session.revoked', 'session.rotated', 'authentication.failed',
    'authorization.denied', 'request.started', 'request.abandoned', 'request.created',
    'request.transition', 'request.transition_failed', 'request.booking_change',
    'tenant.configuration.changed', 'tenant.user_permissions.changed',
    'tenant.entitlement.changed', 'tenant.lifecycle.changed', 'tenant.onboarding.invited',
    'tenant.identity.claimed', 'tenant.identity.unbound', 'tenant.user.provisioned',
    'tenant.user.profile_updated', 'integration.connected', 'integration.disconnected',
    'integration.admin_consent.changed', 'integration.verified', 'calendar.operation', 'audit.read'
  )
);
