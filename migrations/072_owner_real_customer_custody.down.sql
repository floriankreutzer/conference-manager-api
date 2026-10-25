DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM owner_customer_handoffs LIMIT 1)
    OR EXISTS(SELECT 1 FROM owner_handoff_start_budgets LIMIT 1)
    OR EXISTS(SELECT 1 FROM platform_owner_customer_users LIMIT 1)
    OR EXISTS(SELECT 1 FROM sessions WHERE provider='platform_owner' LIMIT 1)
    OR EXISTS(SELECT 1 FROM user_identity_bindings WHERE provider='platform_owner' LIMIT 1)
    OR EXISTS(SELECT 1 FROM platform_audit_events WHERE action='platform.owner_customer_access.approved' LIMIT 1) THEN
    RAISE EXCEPTION 'OWNER_CUSTOMER_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP FUNCTION protected_lock_owner_handoff_source(text,uuid,uuid);
DROP FUNCTION protected_lock_owner_customer_source(text,uuid,uuid);
DROP TRIGGER owner_handoff_session_custody ON sessions;
DROP FUNCTION guard_owner_handoff_session();
DROP TRIGGER owner_customer_identity_custody ON platform_owner_customer_users;
DROP FUNCTION guard_platform_owner_customer_user();
DROP TRIGGER owner_customer_handoff_guard ON owner_customer_handoffs;
DROP FUNCTION guard_owner_customer_handoff();
DROP FUNCTION assert_owner_customer_handoff(public.owner_customer_handoffs);
DROP FUNCTION owner_customer_handoff_operation_hash(public.owner_customer_handoffs);
DROP FUNCTION owner_customer_user_identifier(text,uuid,uuid);
ALTER TABLE owner_customer_handoffs DROP CONSTRAINT owner_handoff_own_user_fk;
DROP TABLE platform_owner_customer_users;
DROP TABLE owner_customer_handoffs,owner_handoff_start_budgets;
DROP FUNCTION guard_owner_customer_history();
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
    'platform.operator.changed',
    'platform.synthetic_access.approved'
  ));
