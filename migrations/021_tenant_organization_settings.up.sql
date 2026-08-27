ALTER TABLE tenants
  ADD COLUMN default_locale varchar(5) NOT NULL DEFAULT 'de',
  ADD COLUMN currency char(3) NOT NULL DEFAULT 'EUR',
  ADD COLUMN brand_accent varchar(32) NOT NULL DEFAULT 'graphite',
  ADD COLUMN logo_asset_id uuid;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_default_locale_valid CHECK (default_locale IN ('de', 'en')),
  ADD CONSTRAINT tenants_currency_valid CHECK (currency IN ('EUR', 'USD', 'GBP', 'CHF')),
  ADD CONSTRAINT tenants_brand_accent_valid CHECK (brand_accent IN ('graphite', 'bordeaux', 'camel'));

CREATE TABLE tenant_brand_assets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  media_type varchar(32) NOT NULL,
  size_bytes integer NOT NULL,
  sha256 char(64) NOT NULL,
  content bytea NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_brand_assets_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_brand_assets_creator_fk
    FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_brand_assets_media_type_valid CHECK (media_type IN ('image/png', 'image/webp')),
  CONSTRAINT tenant_brand_assets_size_valid CHECK (
    size_bytes BETWEEN 1 AND 524288 AND octet_length(content) = size_bytes
  ),
  CONSTRAINT tenant_brand_assets_sha256_valid CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

ALTER TABLE tenants
  ADD CONSTRAINT tenants_logo_asset_fk
  FOREIGN KEY (id, logo_asset_id)
  REFERENCES tenant_brand_assets(tenant_id, id)
  ON DELETE RESTRICT;

CREATE INDEX tenant_brand_assets_created_idx
  ON tenant_brand_assets (tenant_id, created_at DESC, id);
