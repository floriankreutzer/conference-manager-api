BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_location_revisions LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenants WHERE locations_revision <> 1 LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot rollback schema 21 after Tenant location settings have been mutated';
  END IF;
END;
$$;

DROP TRIGGER tenant_location_revisions_immutable_delete ON tenant_location_revisions;
DROP TRIGGER tenant_location_revisions_immutable_update ON tenant_location_revisions;
DROP FUNCTION reject_tenant_location_revision_mutation();
DROP TABLE tenant_location_revisions;

ALTER TABLE rooms DROP CONSTRAINT rooms_details_object;
ALTER TABLE rooms DROP COLUMN details;
ALTER TABLE sites DROP CONSTRAINT sites_details_object;
ALTER TABLE sites DROP COLUMN details;

DELETE FROM schema_migrations WHERE version = 21;

COMMIT;
