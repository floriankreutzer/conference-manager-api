ALTER TABLE sites
  ADD COLUMN guest_information JSONB,
  ADD CONSTRAINT sites_guest_information_object
    CHECK (guest_information IS NULL OR jsonb_typeof(guest_information) = 'object');

ALTER TABLE tenant_location_revisions
  ADD COLUMN guest_information JSONB,
  ADD CONSTRAINT tenant_location_revisions_guest_information_object
    CHECK (guest_information IS NULL OR jsonb_typeof(guest_information) = 'object');
