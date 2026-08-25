ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (
  action IN (
    'session.issued',
    'session.revoked',
    'session.rotated',
    'authentication.failed',
    'authorization.denied',
    'request.created',
    'request.transition',
    'request.transition_failed',
    'tenant.configuration.changed',
    'tenant.user_permissions.changed',
    'tenant.entitlement.changed',
    'tenant.lifecycle.changed',
    'tenant.onboarding.invited',
    'tenant.identity.claimed',
    'tenant.identity.unbound',
    'tenant.user.provisioned',
    'tenant.user.profile_updated',
    'integration.connected',
    'integration.disconnected',
    'integration.admin_consent.changed',
    'integration.verified',
    'calendar.operation',
    'audit.read'
  )
);
