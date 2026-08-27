ALTER TABLE sites
  ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT sites_details_object CHECK (jsonb_typeof(details) = 'object');

ALTER TABLE rooms
  ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT rooms_details_object CHECK (jsonb_typeof(details) = 'object');

CREATE TABLE tenant_location_revisions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  configuration JSONB NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  actor_user_id UUID NOT NULL,
  PRIMARY KEY (tenant_id, revision),
  CONSTRAINT tenant_location_revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT tenant_location_revisions_configuration_object CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT tenant_location_revisions_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX tenant_location_revisions_tenant_changed_idx
  ON tenant_location_revisions (tenant_id, changed_at DESC, revision DESC);

CREATE FUNCTION reject_tenant_location_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'tenant_location_revisions are immutable';
END;
$$;

CREATE TRIGGER tenant_location_revisions_immutable_update
BEFORE UPDATE ON tenant_location_revisions
FOR EACH ROW EXECUTE FUNCTION reject_tenant_location_revision_mutation();

CREATE TRIGGER tenant_location_revisions_immutable_delete
BEFORE DELETE ON tenant_location_revisions
FOR EACH ROW EXECUTE FUNCTION reject_tenant_location_revision_mutation();
