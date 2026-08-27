CREATE TABLE tenant_cost_allocation_configuration (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  allocation_required BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO tenant_cost_allocation_configuration (tenant_id)
SELECT id FROM tenants;

CREATE FUNCTION provision_tenant_cost_allocation_configuration()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO tenant_cost_allocation_configuration (tenant_id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_provision_cost_allocation_configuration
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION provision_tenant_cost_allocation_configuration();

CREATE TABLE tenant_cost_centers (
  tenant_id UUID NOT NULL,
  id VARCHAR(128) NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  group_name VARCHAR(160),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  CONSTRAINT tenant_cost_centers_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_cost_centers_id_valid
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT tenant_cost_centers_code_valid
    CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  CONSTRAINT tenant_cost_centers_name_valid
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT tenant_cost_centers_group_valid
    CHECK (
      group_name IS NULL
      OR char_length(btrim(group_name)) BETWEEN 1 AND 160
    ),
  CONSTRAINT tenant_cost_centers_timestamps_valid
    CHECK (updated_at >= created_at)
);

CREATE TABLE tenant_cost_allocation_revisions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  configuration JSONB NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  actor_user_id UUID NOT NULL,
  PRIMARY KEY (tenant_id, revision),
  CONSTRAINT tenant_cost_allocation_revisions_revision_positive
    CHECK (revision >= 1),
  CONSTRAINT tenant_cost_allocation_revisions_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT tenant_cost_allocation_revisions_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES users(tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX tenant_cost_allocation_revisions_tenant_changed_idx
  ON tenant_cost_allocation_revisions (tenant_id, changed_at DESC, revision DESC);

CREATE FUNCTION reject_tenant_cost_allocation_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'tenant_cost_allocation_revisions are immutable';
END;
$$;

CREATE TRIGGER tenant_cost_allocation_revisions_immutable_update
BEFORE UPDATE ON tenant_cost_allocation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_tenant_cost_allocation_revision_mutation();

CREATE TRIGGER tenant_cost_allocation_revisions_immutable_delete
BEFORE DELETE ON tenant_cost_allocation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_tenant_cost_allocation_revision_mutation();
