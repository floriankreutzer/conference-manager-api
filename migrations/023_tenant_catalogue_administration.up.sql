DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM services
    WHERE currency NOT IN ('CHF', 'EUR', 'GBP', 'USD') OR price_minor > 1000000000
  ) OR EXISTS (
    SELECT 1 FROM catering_packages
    WHERE currency NOT IN ('CHF', 'EUR', 'GBP', 'USD') OR price_minor > 1000000000
  ) OR EXISTS (
    SELECT 1 FROM catering_items
    WHERE currency NOT IN ('CHF', 'EUR', 'GBP', 'USD') OR price_minor > 1000000000
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_CATALOGUE_LEGACY_PRICE_REQUIRES_REVIEW';
  END IF;
END $$;

ALTER TABLE services
  ADD COLUMN description varchar(1000),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT services_description_valid CHECK (
    description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 1000
  ),
  ADD CONSTRAINT services_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000),
  ADD CONSTRAINT services_price_bounded CHECK (price_minor <= 1000000000),
  ADD CONSTRAINT services_currency_supported CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD'));

ALTER TABLE catering_packages
  ADD COLUMN description varchar(1000),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT catering_packages_description_valid CHECK (
    description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 1000
  ),
  ADD CONSTRAINT catering_packages_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000),
  ADD CONSTRAINT catering_packages_price_bounded CHECK (price_minor <= 1000000000),
  ADD CONSTRAINT catering_packages_currency_supported CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD'));

ALTER TABLE catering_items
  ADD COLUMN description varchar(1000),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT catering_items_description_valid CHECK (
    description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 1000
  ),
  ADD CONSTRAINT catering_items_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000),
  ADD CONSTRAINT catering_items_price_bounded CHECK (price_minor <= 1000000000),
  ADD CONSTRAINT catering_items_currency_supported CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD'));

CREATE TABLE equipment (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  description varchar(1000),
  active boolean NOT NULL DEFAULT true,
  price_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'EUR',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT equipment_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT equipment_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT equipment_name_valid CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT equipment_description_valid CHECK (
    description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT equipment_price_valid CHECK (price_minor BETWEEN 0 AND 1000000000),
  CONSTRAINT equipment_currency_valid CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD')),
  CONSTRAINT equipment_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000),
  CONSTRAINT equipment_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE catering_package_variants (
  tenant_id uuid NOT NULL,
  package_id varchar(128) NOT NULL,
  id varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  description varchar(1000),
  active boolean NOT NULL DEFAULT true,
  price_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, package_id, id),
  CONSTRAINT catering_package_variants_package_fk
    FOREIGN KEY (tenant_id, package_id) REFERENCES catering_packages(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_package_variants_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT catering_package_variants_name_valid CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT catering_package_variants_description_valid CHECK (
    description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT catering_package_variants_price_valid CHECK (price_minor BETWEEN 0 AND 1000000000),
  CONSTRAINT catering_package_variants_currency_valid CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD')),
  CONSTRAINT catering_package_variants_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000),
  CONSTRAINT catering_package_variants_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE catering_package_items (
  tenant_id uuid NOT NULL,
  package_id varchar(128) NOT NULL,
  item_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, package_id, item_id),
  CONSTRAINT catering_package_items_package_fk
    FOREIGN KEY (tenant_id, package_id) REFERENCES catering_packages(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_package_items_item_fk
    FOREIGN KEY (tenant_id, item_id) REFERENCES catering_items(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE service_site_applicability (
  tenant_id uuid NOT NULL,
  service_id varchar(128) NOT NULL,
  site_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, service_id, site_id),
  CONSTRAINT service_site_applicability_service_fk
    FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT service_site_applicability_site_fk
    FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE service_room_applicability (
  tenant_id uuid NOT NULL,
  service_id varchar(128) NOT NULL,
  room_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, service_id, room_id),
  CONSTRAINT service_room_applicability_service_fk
    FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT service_room_applicability_room_fk
    FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE equipment_site_applicability (
  tenant_id uuid NOT NULL,
  equipment_id varchar(128) NOT NULL,
  site_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, equipment_id, site_id),
  CONSTRAINT equipment_site_applicability_equipment_fk
    FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT equipment_site_applicability_site_fk
    FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE equipment_room_applicability (
  tenant_id uuid NOT NULL,
  equipment_id varchar(128) NOT NULL,
  room_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, equipment_id, room_id),
  CONSTRAINT equipment_room_applicability_equipment_fk
    FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT equipment_room_applicability_room_fk
    FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE catering_package_site_applicability (
  tenant_id uuid NOT NULL,
  package_id varchar(128) NOT NULL,
  site_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, package_id, site_id),
  CONSTRAINT catering_package_site_applicability_package_fk
    FOREIGN KEY (tenant_id, package_id) REFERENCES catering_packages(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_package_site_applicability_site_fk
    FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE catering_package_room_applicability (
  tenant_id uuid NOT NULL,
  package_id varchar(128) NOT NULL,
  room_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, package_id, room_id),
  CONSTRAINT catering_package_room_applicability_package_fk
    FOREIGN KEY (tenant_id, package_id) REFERENCES catering_packages(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_package_room_applicability_room_fk
    FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE catering_item_site_applicability (
  tenant_id uuid NOT NULL,
  item_id varchar(128) NOT NULL,
  site_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, item_id, site_id),
  CONSTRAINT catering_item_site_applicability_item_fk
    FOREIGN KEY (tenant_id, item_id) REFERENCES catering_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_item_site_applicability_site_fk
    FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE catering_item_room_applicability (
  tenant_id uuid NOT NULL,
  item_id varchar(128) NOT NULL,
  room_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, item_id, room_id),
  CONSTRAINT catering_item_room_applicability_item_fk
    FOREIGN KEY (tenant_id, item_id) REFERENCES catering_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_item_room_applicability_room_fk
    FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE tenant_catalogue_revisions (
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL,
  snapshot jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  actor_user_id uuid,
  correlation_id uuid,
  PRIMARY KEY (tenant_id, revision),
  CONSTRAINT tenant_catalogue_revisions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_catalogue_revisions_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_catalogue_revision_valid CHECK (revision >= 1),
  CONSTRAINT tenant_catalogue_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT tenant_catalogue_snapshot_size CHECK (octet_length(snapshot::text) <= 2097152),
  CONSTRAINT tenant_catalogue_revision_context_valid CHECK (
    (actor_user_id IS NULL AND correlation_id IS NULL)
    OR (actor_user_id IS NOT NULL AND correlation_id IS NOT NULL)
  )
);

CREATE INDEX tenant_catalogue_revisions_time_idx
  ON tenant_catalogue_revisions (tenant_id, effective_at DESC);

CREATE TRIGGER tenant_catalogue_revisions_append_only
BEFORE UPDATE OR DELETE ON tenant_catalogue_revisions
FOR EACH ROW
EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();

CREATE FUNCTION initialize_tenant_catalogue_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO tenant_catalogue_revisions (
    tenant_id,
    revision,
    snapshot,
    effective_at,
    actor_user_id,
    correlation_id
  )
  VALUES (
    NEW.id,
    NEW.catalog_revision,
    jsonb_build_object(
      'services', '[]'::jsonb,
      'equipment', '[]'::jsonb,
      'cateringPackages', '[]'::jsonb,
      'cateringItems', '[]'::jsonb
    ),
    NEW.updated_at,
    NULL,
    NULL
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_initialize_catalogue_revision
AFTER INSERT ON tenants
FOR EACH ROW
EXECUTE FUNCTION initialize_tenant_catalogue_revision();

INSERT INTO tenant_catalogue_revisions (
  tenant_id,
  revision,
  snapshot,
  effective_at,
  actor_user_id,
  correlation_id
)
SELECT
  t.id,
  t.catalog_revision,
  jsonb_build_object(
    'services', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'description', s.description,
        'price', jsonb_build_object('amountMinor', s.price_minor, 'currency', s.currency),
        'active', s.active,
        'order', s.sort_order,
        'siteIds', '[]'::jsonb,
        'roomIds', '[]'::jsonb
      ) ORDER BY s.sort_order, s.id)
      FROM services s
      WHERE s.tenant_id = t.id
    ), '[]'::jsonb),
    'equipment', '[]'::jsonb,
    'cateringPackages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'description', p.description,
        'price', jsonb_build_object('amountMinor', p.price_minor, 'currency', p.currency),
        'active', p.active,
        'order', p.sort_order,
        'siteIds', '[]'::jsonb,
        'roomIds', '[]'::jsonb,
        'itemIds', '[]'::jsonb,
        'variants', '[]'::jsonb
      ) ORDER BY p.sort_order, p.id)
      FROM catering_packages p
      WHERE p.tenant_id = t.id
    ), '[]'::jsonb),
    'cateringItems', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id,
        'name', i.name,
        'description', i.description,
        'price', jsonb_build_object('amountMinor', i.price_minor, 'currency', i.currency),
        'active', i.active,
        'order', i.sort_order,
        'siteIds', '[]'::jsonb,
        'roomIds', '[]'::jsonb
      ) ORDER BY i.sort_order, i.id)
      FROM catering_items i
      WHERE i.tenant_id = t.id
    ), '[]'::jsonb)
  ),
  t.updated_at,
  NULL,
  NULL
FROM tenants t;
