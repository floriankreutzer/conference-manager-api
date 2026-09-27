CREATE TABLE tenant_room_media_assets (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  room_id VARCHAR(128) NOT NULL,
  bytes BYTEA NOT NULL,
  content_type VARCHAR(16) NOT NULL DEFAULT 'image/webp',
  byte_length INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  content_sha256 BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id UUID NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_room_media_room_fk FOREIGN KEY (tenant_id, room_id)
    REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_room_media_creator_fk FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_room_media_webp CHECK (content_type = 'image/webp'),
  CONSTRAINT tenant_room_media_bytes CHECK (
    byte_length BETWEEN 1 AND 2097152 AND octet_length(bytes) = byte_length
  ),
  CONSTRAINT tenant_room_media_pixels CHECK (
    width BETWEEN 1 AND 4000000 AND height BETWEEN 1 AND 4000000
    AND width::BIGINT * height::BIGINT <= 4000000
  ),
  CONSTRAINT tenant_room_media_sha256 CHECK (octet_length(content_sha256) = 32)
);

CREATE INDEX tenant_room_media_room_idx ON tenant_room_media_assets (tenant_id, room_id);

