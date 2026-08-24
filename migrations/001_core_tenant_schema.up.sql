CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  display_name varchar(160) NOT NULL,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tenants_display_name_nonempty CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT tenants_status_valid CHECK (status IN ('pending', 'onboarding', 'ready', 'active', 'suspended', 'archived')),
  CONSTRAINT tenants_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE users (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  display_name varchar(160) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT users_display_name_nonempty CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT users_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE sites (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT sites_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT sites_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT sites_name_nonempty CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT sites_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE rooms (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  site_id varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  capacity integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT rooms_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT rooms_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT rooms_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT rooms_name_nonempty CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT rooms_capacity_valid CHECK (capacity BETWEEN 1 AND 100000),
  CONSTRAINT rooms_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE services (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  price_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'EUR',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT services_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT services_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT services_name_nonempty CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT services_price_valid CHECK (price_minor >= 0),
  CONSTRAINT services_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT services_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE catering_packages (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  price_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'EUR',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT catering_packages_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT catering_packages_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT catering_packages_name_nonempty CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT catering_packages_price_valid CHECK (price_minor >= 0),
  CONSTRAINT catering_packages_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT catering_packages_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE catering_items (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  price_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'EUR',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT catering_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT catering_items_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT catering_items_name_nonempty CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT catering_items_price_valid CHECK (price_minor >= 0),
  CONSTRAINT catering_items_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT catering_items_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE integrations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  provider varchar(64) NOT NULL,
  provider_reference varchar(255) NOT NULL,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_reference),
  CONSTRAINT integrations_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT integrations_provider_valid CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT integrations_reference_nonempty CHECK (char_length(provider_reference) BETWEEN 1 AND 255),
  CONSTRAINT integrations_status_nonempty CHECK (char_length(status) BETWEEN 1 AND 32),
  CONSTRAINT integrations_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE requests (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  requester_user_id uuid NOT NULL,
  room_id varchar(128),
  status varchar(64) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  internal_participants integer NOT NULL DEFAULT 0,
  external_participants integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT requests_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT requests_requester_fk FOREIGN KEY (tenant_id, requester_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT requests_room_fk FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT requests_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT requests_status_nonempty CHECK (char_length(status) BETWEEN 1 AND 64),
  CONSTRAINT requests_schedule_valid CHECK (ends_at > starts_at),
  CONSTRAINT requests_participants_valid CHECK (internal_participants >= 0 AND external_participants >= 0),
  CONSTRAINT requests_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE TABLE notifications (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT notifications_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT notifications_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT notifications_kind_nonempty CHECK (char_length(kind) BETWEEN 1 AND 64)
);

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id uuid,
  action varchar(128) NOT NULL,
  target_type varchar(64) NOT NULL,
  target_id varchar(128) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  outcome varchar(32) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_fk FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_action_nonempty CHECK (char_length(action) BETWEEN 1 AND 128),
  CONSTRAINT audit_events_target_type_nonempty CHECK (char_length(target_type) BETWEEN 1 AND 64),
  CONSTRAINT audit_events_target_id_nonempty CHECK (char_length(target_id) BETWEEN 1 AND 128),
  CONSTRAINT audit_events_outcome_nonempty CHECK (char_length(outcome) BETWEEN 1 AND 32),
  CONSTRAINT audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX requests_tenant_schedule_idx ON requests (tenant_id, starts_at, ends_at);
CREATE INDEX rooms_tenant_site_idx ON rooms (tenant_id, site_id);
CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, occurred_at DESC);
