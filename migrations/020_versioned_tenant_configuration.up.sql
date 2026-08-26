CREATE TABLE tenant_configuration_revisions (
  tenant_id uuid NOT NULL,
  domain varchar(32) NOT NULL,
  revision bigint NOT NULL,
  change_kind varchar(16) NOT NULL,
  source_revision bigint,
  actor_user_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, domain, revision),
  CONSTRAINT tenant_configuration_revisions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_configuration_revisions_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_configuration_revisions_source_fk
    FOREIGN KEY (tenant_id, domain, source_revision)
    REFERENCES tenant_configuration_revisions(tenant_id, domain, revision) ON DELETE RESTRICT,
  CONSTRAINT tenant_configuration_revisions_domain_valid CHECK (
    domain IN ('organization', 'locations', 'catalog', 'booking_policies', 'cost_allocation')
  ),
  CONSTRAINT tenant_configuration_revisions_revision_valid CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT tenant_configuration_revisions_change_kind_valid CHECK (
    change_kind IN ('initial', 'update', 'rollback', 'import')
  ),
  CONSTRAINT tenant_configuration_revisions_source_valid CHECK (
    (change_kind = 'rollback' AND source_revision IS NOT NULL AND source_revision >= 1 AND source_revision < revision)
    OR (change_kind <> 'rollback' AND source_revision IS NULL)
  ),
  CONSTRAINT tenant_configuration_revisions_payload_object CHECK (
    jsonb_typeof(payload) = 'object'
    AND octet_length(payload::text) <= 262144
  )
);

CREATE TABLE tenant_configuration_heads (
  tenant_id uuid NOT NULL,
  domain varchar(32) NOT NULL,
  revision bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, domain),
  CONSTRAINT tenant_configuration_heads_revision_fk
    FOREIGN KEY (tenant_id, domain, revision)
    REFERENCES tenant_configuration_revisions(tenant_id, domain, revision)
    ON DELETE RESTRICT
);

CREATE INDEX tenant_configuration_history_idx
  ON tenant_configuration_revisions (tenant_id, domain, revision DESC);

CREATE FUNCTION reject_tenant_configuration_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'TENANT_CONFIGURATION_REVISIONS_ARE_IMMUTABLE' USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER tenant_configuration_revisions_immutable
BEFORE UPDATE OR DELETE ON tenant_configuration_revisions
FOR EACH ROW EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();

ALTER TABLE sites
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT sites_details_object CHECK (
    jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 32768
  );

ALTER TABLE rooms
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT rooms_details_object CHECK (
    jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 32768
  );

ALTER TABLE services
  ADD COLUMN description varchar(1000),
  ADD COLUMN billing_unit varchar(32) NOT NULL DEFAULT 'per_booking',
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT services_billing_unit_valid CHECK (
    billing_unit IN ('per_booking', 'per_person', 'per_day', 'per_unit')
  ),
  ADD CONSTRAINT services_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 32768
  );

ALTER TABLE catering_packages
  ADD COLUMN description varchar(1000),
  ADD COLUMN billing_unit varchar(32) NOT NULL DEFAULT 'per_booking',
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT catering_packages_billing_unit_valid CHECK (
    billing_unit IN ('per_booking', 'per_person', 'per_day', 'per_unit')
  ),
  ADD CONSTRAINT catering_packages_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 32768
  ),
  ADD CONSTRAINT catering_packages_item_ids_array CHECK (
    jsonb_typeof(item_ids) = 'array' AND octet_length(item_ids::text) <= 32768
  );

ALTER TABLE catering_items
  ADD COLUMN description varchar(1000),
  ADD COLUMN billing_unit varchar(32) NOT NULL DEFAULT 'per_unit',
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT catering_items_billing_unit_valid CHECK (
    billing_unit IN ('per_booking', 'per_person', 'per_day', 'per_unit')
  ),
  ADD CONSTRAINT catering_items_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 32768
  );

CREATE TABLE tenant_brand_assets (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
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
  CONSTRAINT tenant_brand_assets_id_valid CHECK (
    id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT tenant_brand_assets_media_type_valid CHECK (
    media_type IN ('image/png', 'image/webp')
  ),
  CONSTRAINT tenant_brand_assets_size_valid CHECK (
    size_bytes BETWEEN 1 AND 524288 AND octet_length(content) = size_bytes
  ),
  CONSTRAINT tenant_brand_assets_sha256_valid CHECK (
    sha256 ~ '^[0-9a-f]{64}$'
  )
);
