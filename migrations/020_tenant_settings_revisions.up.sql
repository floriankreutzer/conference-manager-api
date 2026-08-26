ALTER TABLE tenants
  ADD COLUMN organization_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN locations_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN catalog_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN booking_policies_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN cost_allocation_revision bigint NOT NULL DEFAULT 1;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_organization_revision_valid CHECK (organization_revision >= 1),
  ADD CONSTRAINT tenants_locations_revision_valid CHECK (locations_revision >= 1),
  ADD CONSTRAINT tenants_catalog_revision_valid CHECK (catalog_revision >= 1),
  ADD CONSTRAINT tenants_booking_policies_revision_valid CHECK (booking_policies_revision >= 1),
  ADD CONSTRAINT tenants_cost_allocation_revision_valid CHECK (cost_allocation_revision >= 1);
