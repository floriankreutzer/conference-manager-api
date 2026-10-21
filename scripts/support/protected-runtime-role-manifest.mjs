// Operator-only positive grants. Runtime processes cannot import this installer.
// No ownership, wildcard tables, default privileges, migrations or role creation.
const BUSINESS = [
  'sites','rooms','services','catering_packages','catering_items','integrations','requests','notifications',
  'booking_provider_references','tenant_user_roles','user_identity_bindings','tenant_identity_bindings',
  'microsoft365_consent_transactions','microsoft365_room_mappings','microsoft365_capability_health',
  'microsoft365_room_discovery_observations','booking_change_requests','tenant_organization_settings',
  'equipment','catering_package_variants','catering_package_items','service_site_applicability','service_room_applicability',
  'equipment_site_applicability','equipment_room_applicability','catering_package_site_applicability',
  'catering_package_room_applicability','catering_item_site_applicability','catering_item_room_applicability',
  'tenant_booking_policy_configuration','tenant_cost_allocation_configuration','tenant_cost_centers','tenant_room_prices',
  'catering_integration_configurations','catering_catalogue_assignment_heads','catering_order_heads','catering_order_version_states',
  'catering_delivery_jobs','catering_manual_delivery_heads','catering_provider_catalogue_heads',
  'catering_catalogue_review_heads','catering_catalogue_publication_heads',
];
const HISTORY = [
  'audit_events','tenant_location_revisions','tenant_organization_revisions','tenant_catalogue_revisions',
  'tenant_booking_policy_revisions','tenant_cost_allocation_revisions','request_revisions','tenant_bulk_transfer_receipts',
  'tenant_room_media_assets','request_workflow_starts','catering_integration_configuration_revisions',
  'catering_catalogue_assignment_revisions','catering_catalogue_assignment_entries','catering_catalogue_assignment_seals',
  'catering_orders','catering_order_versions','catering_order_positions','catering_order_version_seals','catering_order_quotes',
  'catering_order_decisions','catering_delivery_attempts','catering_delivery_observations','catering_manual_delivery_facts',
  'catering_version_proposals','catering_order_withdrawals','catering_unsent_replacements',
  'catering_provider_catalogue_revisions','catering_catalogue_reviews',
];
const READ = ['schema_migrations','protected_runtime_deployments','protected_runtime_epoch_history',
  'tenant_runtime_registry','synthetic_tenant_generations','request_v2_migration_state','request_attribution_migration_state'];
const MEMBERSHIP = ['customer_access_mailboxes','customer_access_memberships','customer_member_invitations'];
const COMMON_FUNCTIONS = [
  'customer_access_envelope_valid(jsonb)','customer_invitation_receipt_valid(jsonb)',
  'catering_provider_catalogue_text_valid(jsonb,integer,boolean)','catering_provider_catalogue_money_valid(jsonb,boolean)',
  'catering_provider_catalogue_product_valid(jsonb)','catering_provider_catalogue_document_valid(jsonb)',
  'catering_catalogue_review_mapping_valid(jsonb,boolean,boolean)','catering_catalogue_review_command_valid(jsonb)',
  'catering_order_source_current(uuid,uuid,bigint)','catering_delivery_authority_current(public.catering_delivery_jobs)',
  'catering_order_delivery_operation(uuid,uuid,bigint)',
];
const CRUD = 'SELECT,INSERT,UPDATE,DELETE';
function table(name,privileges) { return Object.freeze({ name,privileges }); }
function columns(name,privilege,names) { return table(name,`${privilege}(${names})`); }

export function protectedRuntimeRoleManifest(surface) {
  if (!['customer','platform'].includes(surface)) throw new TypeError('PROTECTED_ROLE_SURFACE_INVALID');
  const tables=[...BUSINESS.map(name=>table(name,CRUD)),...HISTORY.map(name=>table(name,'SELECT,INSERT')),
    ...READ.map(name=>table(name,'SELECT')),...MEMBERSHIP.map(name=>table(name,'SELECT,INSERT,UPDATE')),
    table('users',CRUD),table('customer_access_commands','SELECT,INSERT'),table('tenant_entitlements','SELECT'),
    table('media_object_inventory','SELECT,INSERT'),columns('media_object_inventory','UPDATE','object_key'),
    table('platform_diagnostic_events','INSERT')];
  const functions=[...COMMON_FUNCTIONS];
  if (surface==='customer') {
    tables.push(table('tenants','SELECT'),columns('tenants','UPDATE',
      'display_name,updated_at,locations_revision,organization_revision,catalog_revision,'
        +'booking_policies_revision,cost_allocation_revision'),
    ...['sessions','customer_email_challenges','customer_access_deliveries','customer_access_abuse_budgets',
      'customer_microsoft_flows','customer_microsoft_start_budgets','synthetic_customer_handoffs','synthetic_handoff_start_budgets']
      .map(name=>table(name,CRUD)),table('synthetic_catalogue_media_assets','SELECT'),
    columns('platform_operators','SELECT','id,provider,provider_tenant_reference,provider_subject_reference,'
      +'status,security_version,roles,scope_mode'),
    columns('platform_sessions','SELECT','id,operator_id,provider,provider_tenant_reference,provider_subject_reference,roles,permissions,'
      +'scope_mode,principal_version,security_epoch,assurance_level,authentication_context,'
      +'revoked_at,issued_at,expires_at,authenticated_at'),
    columns('platform_passkey_credentials','SELECT','operator_id,environment,revoked_at'),
    columns('platform_passkey_auth_transactions','SELECT','id,operator_id,environment,security_epoch,operator_security_version,purpose,'
      +'operation_hash,expected_session_id,consumed_at,expires_at'),
    columns('platform_audit_events','SELECT','sequence,operator_id,action,target_tenant_id,outcome,assurance_level,metadata'));
    functions.push('customer_microsoft_snapshot_valid(jsonb)','protected_lock_synthetic_handoff_source(text,uuid,uuid)');
  } else {
    tables.push(table('tenants',CRUD),table('platform_operators','SELECT,UPDATE'),
    ...['platform_operator_tenant_scopes','platform_sessions','platform_oidc_auth_transactions',
      'platform_passkey_auth_transactions','platform_passkey_enrollment_transactions','platform_passkey_credentials',
      'platform_operation_receipts','platform_tenant_readiness_snapshots','platform_microsoft_fleet_snapshots',
      'platform_microsoft_fleet_capabilities','platform_projection_outbox'].map(name=>table(name,CRUD)),
    table('platform_passkey_enrollment_grants','SELECT'),
    columns('platform_passkey_enrollment_grants','UPDATE','consumed_at,revoked_at'),
    table('platform_audit_events','SELECT,INSERT'),table('platform_audit_checkpoints','SELECT,INSERT'),
    table('platform_audit_chain_state','SELECT,UPDATE'),table('platform_tenant_readiness_evidence','SELECT,INSERT'),
    table('platform_entitlement_packages','SELECT,INSERT,UPDATE'),table('platform_entitlement_package_revisions','SELECT,INSERT'),
    table('platform_entitlement_change_history','SELECT,INSERT'),
    columns('tenant_entitlements','INSERT','tenant_id,capability_id,enabled,updated_at'),
    columns('tenant_entitlements','UPDATE','enabled,updated_at'),
    table('tenant_onboarding_invitations','SELECT'),table('synthetic_catalogue_media_assets','SELECT,INSERT'),
    columns('protected_runtime_deployments','UPDATE','updated_at'),table('tenant_runtime_registry','INSERT'),
    table('synthetic_tenant_generations','INSERT,UPDATE'),table('synthetic_customer_handoffs','SELECT,UPDATE'),
    columns('sessions','SELECT','id,tenant_id,user_id,revoked_at,expires_at,principal_version'),columns('sessions','UPDATE','revoked_at'),
    table('customer_access_deliveries','INSERT'),
    columns('customer_access_deliveries','SELECT','environment,id,tenant_id,invitation_id,invitation_revision,created_at,status'),
    columns('customer_access_deliveries','UPDATE','status'));
    functions.push('protected_runtime_acquire_exclusive(text)');
  }
  return Object.freeze({ tables: Object.freeze(tables),functions: Object.freeze(functions),
    sequences: Object.freeze(['audit_events_id_seq','request_revisions_revision_sequence_seq','platform_diagnostic_events_id_seq',
      ...(surface==='platform' ? ['platform_entitlement_change_history_id_seq'] : [])]) });
}
