CREATE TABLE tenant_organization_settings (
  tenant_id uuid PRIMARY KEY,
  legal_name varchar(160),
  registration_number varchar(80),
  country_code char(2),
  default_locale varchar(16) NOT NULL DEFAULT 'de-DE',
  default_currency char(3) NOT NULL DEFAULT 'EUR',
  logo_asset_ref varchar(160),
  accent_token varchar(32) NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_user_id uuid,
  CONSTRAINT tenant_organization_settings_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_organization_settings_updater_fk
    FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_organization_legal_name_valid
    CHECK (legal_name IS NULL OR char_length(btrim(legal_name)) BETWEEN 1 AND 160),
  CONSTRAINT tenant_organization_registration_valid
    CHECK (registration_number IS NULL OR char_length(btrim(registration_number)) BETWEEN 1 AND 80),
  CONSTRAINT tenant_organization_country_valid
    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT tenant_organization_locale_valid
    CHECK (default_locale IN ('de-DE', 'en-GB')),
  CONSTRAINT tenant_organization_currency_valid
    CHECK (default_currency IN ('CHF', 'EUR', 'GBP', 'USD')),
  CONSTRAINT tenant_organization_logo_reference_valid
    CHECK (logo_asset_ref IS NULL OR logo_asset_ref ~ '^managed-brand:[A-Za-z0-9_-]{22,128}$'),
  CONSTRAINT tenant_organization_accent_valid
    CHECK (accent_token = 'default'),
  CONSTRAINT tenant_organization_timestamps_valid
    CHECK (updated_at >= created_at)
);

CREATE TABLE tenant_organization_revisions (
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL,
  snapshot jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  actor_user_id uuid,
  correlation_id uuid,
  PRIMARY KEY (tenant_id, revision),
  CONSTRAINT tenant_organization_revisions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_organization_revisions_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_organization_revision_valid CHECK (revision >= 1),
  CONSTRAINT tenant_organization_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT tenant_organization_snapshot_size CHECK (octet_length(snapshot::text) <= 16384),
  CONSTRAINT tenant_organization_revision_context_valid CHECK (
    (actor_user_id IS NULL AND correlation_id IS NULL)
    OR (actor_user_id IS NOT NULL AND correlation_id IS NOT NULL)
  )
);

CREATE INDEX tenant_organization_revisions_time_idx
  ON tenant_organization_revisions (tenant_id, effective_at DESC);

CREATE FUNCTION reject_tenant_configuration_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'TENANT_CONFIGURATION_REVISIONS_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER tenant_organization_revisions_append_only
BEFORE UPDATE OR DELETE ON tenant_organization_revisions
FOR EACH ROW
EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();

CREATE FUNCTION initialize_tenant_organization_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO tenant_organization_settings (
    tenant_id,
    default_locale,
    default_currency,
    accent_token,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    'de-DE',
    'EUR',
    'default',
    NEW.created_at,
    NEW.updated_at
  );

  INSERT INTO tenant_organization_revisions (
    tenant_id,
    revision,
    snapshot,
    effective_at,
    actor_user_id,
    correlation_id
  )
  VALUES (
    NEW.id,
    NEW.organization_revision,
    jsonb_build_object(
      'displayName', NEW.display_name,
      'businessMetadata', jsonb_build_object(
        'legalName', NULL,
        'registrationNumber', NULL,
        'countryCode', NULL
      ),
      'presentation', jsonb_build_object(
        'defaultLocale', 'de-DE',
        'defaultCurrency', 'EUR'
      ),
      'branding', jsonb_build_object(
        'logoAssetRef', NULL,
        'accentToken', 'default'
      )
    ),
    NEW.updated_at,
    NULL,
    NULL
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_initialize_organization_settings
AFTER INSERT ON tenants
FOR EACH ROW
EXECUTE FUNCTION initialize_tenant_organization_settings();

INSERT INTO tenant_organization_settings (
  tenant_id,
  default_locale,
  default_currency,
  accent_token,
  created_at,
  updated_at
)
SELECT id, 'de-DE', 'EUR', 'default', created_at, updated_at
FROM tenants;

INSERT INTO tenant_organization_revisions (
  tenant_id,
  revision,
  snapshot,
  effective_at,
  actor_user_id,
  correlation_id
)
SELECT
  id,
  organization_revision,
  jsonb_build_object(
    'displayName', display_name,
    'businessMetadata', jsonb_build_object(
      'legalName', NULL,
      'registrationNumber', NULL,
      'countryCode', NULL
    ),
    'presentation', jsonb_build_object(
      'defaultLocale', 'de-DE',
      'defaultCurrency', 'EUR'
    ),
    'branding', jsonb_build_object(
      'logoAssetRef', NULL,
      'accentToken', 'default'
    )
  ),
  updated_at,
  NULL,
  NULL
FROM tenants;
