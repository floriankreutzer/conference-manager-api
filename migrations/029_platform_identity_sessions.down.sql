LOCK TABLE platform_operator_change_alert_outbox IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_security_alert_outbox IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_break_glass_alert_outbox IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_break_glass_grants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_oidc_auth_transactions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_operator_tenant_scopes IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_operators IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_operator_change_alert_outbox LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_security_alert_outbox LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_break_glass_alert_outbox LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_break_glass_grants LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_oidc_auth_transactions LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_sessions LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_operator_tenant_scopes LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_operators LIMIT 1) THEN
    RAISE EXCEPTION 'PLATFORM_IDENTITY_SESSION_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE platform_security_alert_outbox;
DROP TABLE platform_operator_change_alert_outbox;
DROP TABLE platform_break_glass_alert_outbox;
DROP TRIGGER platform_break_glass_grant_protection ON platform_break_glass_grants;
DROP FUNCTION protect_platform_break_glass_grant();
DROP INDEX platform_break_glass_active_idx;
DROP TABLE platform_break_glass_grants;
DROP INDEX platform_oidc_expiry_idx;
DROP TABLE platform_oidc_auth_transactions;
DROP INDEX platform_sessions_operator_active_idx;
DROP TABLE platform_sessions;
DROP TRIGGER platform_operator_tenant_scope_invalidation ON platform_operator_tenant_scopes;
DROP FUNCTION invalidate_platform_operator_scope_sessions();
DROP TABLE platform_operator_tenant_scopes;
DROP TRIGGER platform_operator_security_version ON platform_operators;
DROP FUNCTION enforce_platform_operator_security_version();
DROP TABLE platform_operators;
DROP FUNCTION platform_permissions_for_roles(TEXT[]);
DROP FUNCTION platform_roles_are_canonical(TEXT[]);
