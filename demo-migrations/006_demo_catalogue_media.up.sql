CREATE TABLE demo_catalogue_media_assets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  owner_kind varchar(20) NOT NULL CHECK (owner_kind IN ('room_plan', 'catering_package', 'catering_item')),
  owner_id varchar(128) NOT NULL,
  bytes bytea NOT NULL,
  content_type varchar(16) NOT NULL CHECK (content_type IN ('image/png', 'image/webp')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 32 AND 2097152),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  alt_text varchar(160) NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_kind, owner_id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id),
  CHECK (octet_length(bytes) = byte_length)
);

DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('GRANT SELECT ON TABLE public.demo_catalogue_media_assets TO %I', customer_role);
  EXECUTE format('GRANT UPDATE (bytes, content_type, byte_length, content_sha256) ON TABLE public.demo_catalogue_media_assets TO %I', customer_role);
  EXECUTE format('GRANT SELECT, INSERT, TRUNCATE ON TABLE public.demo_catalogue_media_assets TO %I', reset_role);
END;
$$;
