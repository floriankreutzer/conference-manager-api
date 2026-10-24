const COMMON_READ=['schema_migrations','protected_runtime_deployments','tenant_runtime_registry','synthetic_tenant_generations'];
const CUSTOMER_READ=['tenants','users','tenant_user_roles','tenant_microsoft_role_settings',
  'customer_microsoft_group_observations','user_identity_bindings','audit_events','sessions',
  'customer_access_mailboxes','customer_access_memberships','customer_member_invitations','customer_email_challenges',
  'customer_access_deliveries','customer_access_abuse_budgets','customer_microsoft_flows','customer_microsoft_start_budgets'];
const CUSTOMER_WRITE=['sessions','customer_email_challenges','customer_access_deliveries','customer_access_abuse_budgets',
  'customer_microsoft_flows','customer_microsoft_start_budgets'];
const CUSTOMER_FORBIDDEN=['platform_microsoft_operation_proofs','platform_operators','platform_sessions',
  'platform_oidc_auth_transactions','platform_audit_events',
  'platform_passkey_credentials','platform_passkey_auth_transactions','platform_passkey_enrollment_grants',
  'platform_passkey_enrollment_transactions','protected_runtime_deployments','protected_runtime_epoch_history',
  'tenant_runtime_registry','synthetic_tenant_generations'];
const PLATFORM_READ=['platform_microsoft_operation_proofs','platform_operators','platform_sessions',
  'platform_oidc_auth_transactions','platform_audit_events',
  'platform_passkey_credentials','platform_passkey_auth_transactions','platform_passkey_enrollment_grants',
  'platform_passkey_enrollment_transactions'];
const MICROSOFT_CUSTODY_READ_COLUMNS=['id','operator_id','environment','protected_security_epoch','security_epoch',
  'operator_security_version','provider_tenant_reference','provider_subject_reference','execution_scope','status','operation_hash',
  'expected_session_id','consumed_at','expires_at','authenticated_at'].map(name=>`platform_microsoft_operation_proofs.${name}`);
const POLICIES=Object.freeze({
  customer: Object.freeze({ read: Object.freeze([...COMMON_READ,...CUSTOMER_READ]),write: Object.freeze(CUSTOMER_WRITE),
    forbiddenMutation: Object.freeze(CUSTOMER_FORBIDDEN),forbiddenInsert: Object.freeze([]),
    readColumns: Object.freeze([...MICROSOFT_CUSTODY_READ_COLUMNS,'platform_sessions.step_up_expires_at']),
    forbiddenReadColumns: Object.freeze(['state_hash','browser_hash','nonce_hash']
      .map(name=>`platform_microsoft_operation_proofs.${name}`)) }),
  platform: Object.freeze({ read: Object.freeze([...COMMON_READ,...PLATFORM_READ]),
    write: Object.freeze(['platform_microsoft_operation_proofs','platform_sessions','platform_oidc_auth_transactions',
      'platform_passkey_auth_transactions',
      'platform_passkey_enrollment_transactions']),forbiddenMutation: Object.freeze([]),
    forbiddenInsert: Object.freeze(['platform_passkey_enrollment_grants']),
    readColumns: Object.freeze([]),forbiddenReadColumns: Object.freeze([]) }),
});

// Minimal startup posture, not the complete business GRANT inventory or a grant
// installer. Ordinary database permissions still enforce every actual statement.
export function protectedRuntimeRoleRequirements(surface) {
  if (typeof surface!=='string' || !Object.hasOwn(POLICIES,surface)) throw new TypeError('PROTECTED_RUNTIME_ROLE_SURFACE_INVALID');
  return POLICIES[surface];
}
