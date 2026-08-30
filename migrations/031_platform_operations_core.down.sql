LOCK TABLE platform_entitlement_change_history IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_entitlement_package_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_entitlement_packages IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_operation_receipts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_entitlement_change_history LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_entitlement_package_revisions LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_entitlement_packages LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_operation_receipts LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenant_onboarding_invitations WHERE revision <> 1 OR revoked_at IS NOT NULL OR reissued_from_id IS NOT NULL LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenants WHERE lifecycle_revision <> 1 OR entitlement_revision <> 1 OR customer_session_revision <> 1 LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenant_identity_bindings WHERE revision <> 1 LIMIT 1)
     OR EXISTS (SELECT 1 FROM microsoft365_room_mappings WHERE revision <> 1 LIMIT 1) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATIONS_CORE_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER platform_entitlement_change_history_append_only ON platform_entitlement_change_history;
DROP TRIGGER platform_entitlement_package_revisions_append_only ON platform_entitlement_package_revisions;
DROP FUNCTION reject_platform_operations_history_mutation();
DROP INDEX platform_entitlement_history_tenant_time_idx;
DROP TABLE platform_entitlement_change_history;
DROP TABLE platform_entitlement_package_revisions;
DROP TRIGGER platform_entitlement_packages_protected ON platform_entitlement_packages;
DROP FUNCTION protect_platform_entitlement_package();
DROP TABLE platform_entitlement_packages;
DROP TRIGGER platform_operation_receipts_protected ON platform_operation_receipts;
DROP FUNCTION protect_platform_operation_receipt();
DROP INDEX platform_operation_receipts_retention_idx;
DROP INDEX platform_operation_receipts_global_key_idx;
DROP INDEX platform_operation_receipts_tenant_key_idx;
DROP TABLE platform_operation_receipts;

DROP TRIGGER microsoft365_room_mappings_revision_guard ON microsoft365_room_mappings;
DROP FUNCTION manage_microsoft365_room_mapping_revision();
ALTER TABLE microsoft365_room_mappings
  DROP CONSTRAINT microsoft365_room_mappings_revision_valid,
  DROP CONSTRAINT microsoft365_room_mappings_id_unique,
  DROP COLUMN revision,
  DROP COLUMN id;

DROP TRIGGER tenant_identity_bindings_revision_guard ON tenant_identity_bindings;
DROP FUNCTION manage_tenant_identity_binding_revision();
ALTER TABLE tenant_identity_bindings
  DROP CONSTRAINT tenant_identity_bindings_revision_valid,
  DROP COLUMN revision;

DROP TRIGGER tenant_onboarding_invitations_revision_guard ON tenant_onboarding_invitations;
DROP FUNCTION protect_tenant_onboarding_invitation_revision();
DROP INDEX tenant_onboarding_invitations_reissue_unique_idx;
DROP INDEX tenant_onboarding_invitations_open_tenant_idx;
ALTER TABLE tenant_onboarding_invitations
  DROP CONSTRAINT tenant_onboarding_invitations_reissue_fk,
  DROP CONSTRAINT tenant_onboarding_invitations_reissue_distinct,
  DROP CONSTRAINT tenant_onboarding_invitations_terminal_valid,
  DROP CONSTRAINT tenant_onboarding_invitations_revision_valid,
  DROP COLUMN reissued_from_id,
  DROP COLUMN revoked_at,
  DROP COLUMN revision;

DROP TRIGGER tenants_platform_revisions ON tenants;
DROP FUNCTION manage_tenant_platform_revisions();
ALTER TABLE tenants
  DROP CONSTRAINT tenants_customer_session_revision_valid,
  DROP CONSTRAINT tenants_entitlement_revision_valid,
  DROP CONSTRAINT tenants_lifecycle_revision_valid,
  DROP COLUMN customer_session_revision,
  DROP COLUMN entitlement_revision,
  DROP COLUMN lifecycle_revision;

DROP FUNCTION platform_add_utc_months(TIMESTAMPTZ, INTEGER);
