DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenants
    WHERE organization_revision <> 1
       OR default_locale <> 'de'
       OR currency <> 'EUR'
       OR brand_accent <> 'graphite'
       OR logo_asset_id IS NOT NULL
  ) OR EXISTS (SELECT 1 FROM tenant_brand_assets) THEN
    RAISE EXCEPTION 'TENANT_ORGANIZATION_SETTINGS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE tenants DROP CONSTRAINT tenants_logo_asset_fk;
DROP INDEX tenant_brand_assets_created_idx;
DROP TABLE tenant_brand_assets;
ALTER TABLE tenants
  DROP CONSTRAINT tenants_default_locale_valid,
  DROP CONSTRAINT tenants_currency_valid,
  DROP CONSTRAINT tenants_brand_accent_valid,
  DROP COLUMN logo_asset_id,
  DROP COLUMN brand_accent,
  DROP COLUMN currency,
  DROP COLUMN default_locale;
