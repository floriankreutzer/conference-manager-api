CREATE TABLE microsoft365_room_mappings (
  tenant_id uuid NOT NULL,
  room_id varchar(128) NOT NULL,
  integration_id uuid NOT NULL,
  external_room_id varchar(512) NOT NULL,
  resource_address varchar(320) NOT NULL,
  provider_display_name varchar(512) NOT NULL,
  provider_capacity integer,
  provider_status varchar(16) NOT NULL DEFAULT 'active',
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, room_id),
  UNIQUE (tenant_id, integration_id, external_room_id),
  CONSTRAINT microsoft365_room_mapping_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT microsoft365_room_mapping_room_fk
    FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT microsoft365_room_mapping_integration_fk
    FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT microsoft365_room_mapping_external_id_valid
    CHECK (char_length(btrim(external_room_id)) BETWEEN 1 AND 512),
  CONSTRAINT microsoft365_room_mapping_address_valid
    CHECK (char_length(btrim(resource_address)) BETWEEN 3 AND 320),
  CONSTRAINT microsoft365_room_mapping_display_name_valid
    CHECK (char_length(btrim(provider_display_name)) BETWEEN 1 AND 512),
  CONSTRAINT microsoft365_room_mapping_capacity_valid
    CHECK (provider_capacity IS NULL OR provider_capacity BETWEEN 0 AND 1000000),
  CONSTRAINT microsoft365_room_mapping_status_valid
    CHECK (provider_status IN ('active', 'missing')),
  CONSTRAINT microsoft365_room_mapping_timestamps_valid
    CHECK (
      last_seen_at >= created_at
      AND last_seen_at <= updated_at
      AND updated_at >= created_at
    )
);

CREATE UNIQUE INDEX microsoft365_room_mapping_address_unique
  ON microsoft365_room_mappings (tenant_id, integration_id, lower(resource_address));
