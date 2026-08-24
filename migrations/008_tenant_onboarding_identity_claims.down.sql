DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_onboarding_invitations LIMIT 1)
    OR EXISTS (SELECT 1 FROM tenant_identity_bindings LIMIT 1)
    OR EXISTS (SELECT 1 FROM tenant_claim_transactions LIMIT 1)
    OR EXISTS (
      SELECT 1
      FROM oidc_auth_transactions
      WHERE onboarding_invitation_id IS NOT NULL
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM audit_events
      WHERE action IN (
        'tenant.onboarding.invited',
        'tenant.identity.claimed',
        'tenant.identity.unbound'
      )
      LIMIT 1
    )
  THEN
    RAISE EXCEPTION 'TENANT_ONBOARDING_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE oidc_auth_transactions
  DROP CONSTRAINT oidc_auth_transactions_onboarding_invitation_fk,
  DROP COLUMN onboarding_invitation_id;

DROP TABLE tenant_claim_transactions;
DROP TABLE tenant_identity_bindings;
DROP TABLE tenant_onboarding_invitations;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'session.issued',
    'session.revoked',
    'session.rotated',
    'authentication.failed',
    'authorization.denied',
    'request.transition',
    'request.transition_failed',
    'tenant.configuration.changed',
    'tenant.user_permissions.changed',
    'tenant.entitlement.changed',
    'integration.connected',
    'integration.disconnected',
    'integration.admin_consent.changed',
    'calendar.operation',
    'audit.read'
  )
);
