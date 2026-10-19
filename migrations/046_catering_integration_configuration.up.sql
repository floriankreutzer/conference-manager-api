-- No connection is backfilled or activated. Provider registration remains source-controlled.
CREATE TABLE catering_integration_configurations (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1 AND revision < 9007199254740991),
  initial_order_mode varchar(32) NOT NULL CHECK (initial_order_mode IN ('after_conference_approval', 'manager_review')),
  catalogue_mode varchar(16) NOT NULL CHECK (catalogue_mode IN ('api', 'manual', 'unsupported')),
  availability_mode varchar(16) NOT NULL CHECK (availability_mode IN ('api', 'manual', 'unsupported')),
  order_mode varchar(16) NOT NULL CHECK (order_mode IN ('api', 'manual', 'unsupported')),
  update_mode varchar(16) NOT NULL CHECK (update_mode IN ('api', 'manual', 'unsupported')),
  cancel_mode varchar(16) NOT NULL CHECK (cancel_mode IN ('api', 'manual', 'unsupported')),
  status_mode varchar(16) NOT NULL CHECK (status_mode IN ('api', 'manual', 'unsupported')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  updated_by_user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, integration_id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE catering_integration_configuration_revisions (
  LIKE catering_integration_configurations INCLUDING CONSTRAINTS,
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, integration_id, revision),
  FOREIGN KEY (tenant_id, integration_id)
    REFERENCES catering_integration_configurations(tenant_id, integration_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
ALTER TABLE catering_integration_configurations ADD CONSTRAINT catering_configuration_current_revision_fk
  FOREIGN KEY (tenant_id, integration_id, revision)
  REFERENCES catering_integration_configuration_revisions(tenant_id, integration_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_catering_configuration_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.tenant_id, NEW.integration_id, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.integration_id, OLD.created_at)
     OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'CATERING_CONFIGURATION_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_catering_configuration_revision() FROM PUBLIC;
CREATE TRIGGER catering_configuration_revision_guard BEFORE UPDATE ON catering_integration_configurations
  FOR EACH ROW EXECUTE FUNCTION guard_catering_configuration_revision();
CREATE TRIGGER catering_configuration_history_append_only
  BEFORE UPDATE OR DELETE ON catering_integration_configuration_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();
REVOKE ALL ON TABLE catering_integration_configurations, catering_integration_configuration_revisions FROM PUBLIC;
