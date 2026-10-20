DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM synthetic_customer_handoffs LIMIT 1)
    OR EXISTS(SELECT 1 FROM synthetic_handoff_start_budgets LIMIT 1)
    OR EXISTS(SELECT 1 FROM sessions WHERE provider='platform_delegation' LIMIT 1)
    OR EXISTS(SELECT 1 FROM platform_audit_events WHERE action='platform.synthetic_access.approved' LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_HANDOFF_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TRIGGER synthetic_handoff_session_custody ON sessions;
DROP FUNCTION guard_synthetic_handoff_session();
DROP FUNCTION assert_synthetic_handoff_approval(public.synthetic_customer_handoffs);
DROP TABLE synthetic_customer_handoffs,synthetic_handoff_start_budgets;
DROP FUNCTION guard_synthetic_customer_handoff();
DROP FUNCTION guard_synthetic_handoff_truncate();
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_action_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_action_valid CHECK(action IN (
    'platform.authentication.succeeded',
    'platform.authentication.failed',
    'platform.authorization.denied',
    'platform.session.issued',
    'platform.session.rotated',
    'platform.session.revoked',
    'platform.session.epoch_rejected',
    'platform.break_glass.granted',
    'platform.break_glass.revoked',
    'platform.break_glass.used',
    'platform.break_glass.denied',
    'platform.tenant.directory.read',
    'platform.tenant.registration.changed',
    'platform.tenant.invitation.changed',
    'platform.tenant.lifecycle.changed',
    'platform.tenant.entitlement.changed',
    'platform.tenant.quota.changed',
    'platform.tenant.configuration.changed',
    'platform.tenant.integration.changed',
    'platform.tenant.readiness.read',
    'platform.diagnostics.read',
    'platform.metering.read',
    'platform.runtime.read',
    'platform.recovery.previewed',
    'platform.recovery.executed',
    'platform.audit.read',
    'platform.audit.exported',
    'platform.operator.changed'
  ));
