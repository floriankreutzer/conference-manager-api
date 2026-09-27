ALTER TABLE sites
  ADD COLUMN guest_public_values JSONB,
  ADD CONSTRAINT sites_guest_public_values_object
    CHECK (guest_public_values IS NULL OR jsonb_typeof(guest_public_values) = 'object');

ALTER TABLE rooms
  ADD COLUMN guest_public_values JSONB,
  ADD CONSTRAINT rooms_guest_public_values_object
    CHECK (guest_public_values IS NULL OR jsonb_typeof(guest_public_values) = 'object');

ALTER TABLE tenant_location_revisions
  ADD COLUMN guest_public_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT tenant_location_revisions_guest_public_values_object
    CHECK (jsonb_typeof(guest_public_values) = 'object');

-- Legacy guest_information and Room free text remain private for the compatibility window.
-- No migration promotes unrestricted prose into public structured values.
