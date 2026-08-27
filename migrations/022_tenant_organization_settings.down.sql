LOCK TABLE tenant_organization_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_organization_settings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenants
    WHERE organization_revision <> 1
  ) OR EXISTS (
    SELECT 1
    FROM tenant_organization_revisions
    WHERE revision <> 1
  ) OR EXISTS (
    SELECT 1
    FROM tenant_organization_settings
    WHERE legal_name IS NOT NULL
      OR registration_number IS NOT NULL
      OR country_code IS NOT NULL
      OR default_locale <> 'de-DE'
      OR default_currency <> 'EUR'
      OR logo_asset_ref IS NOT NULL
      OR accent_token <> 'default'
      OR updated_by_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_ORGANIZATION_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;

DROP TRIGGER tenants_initialize_organization_settings ON tenants;
DROP FUNCTION initialize_tenant_organization_settings();
DROP TRIGGER tenant_organization_revisions_append_only ON tenant_organization_revisions;
DROP TABLE tenant_organization_revisions;
DROP TABLE tenant_organization_settings;
DROP FUNCTION reject_tenant_configuration_revision_mutation();
