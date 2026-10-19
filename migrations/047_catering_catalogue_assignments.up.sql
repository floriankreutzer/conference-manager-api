-- Version-specific ownership never rewrites the canonical catalogue or activates an Integration.
CREATE TABLE catering_catalogue_assignment_revisions (
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1 AND revision < 9007199254740991),
  catalogue_revision bigint NOT NULL CHECK (catalogue_revision >= 1 AND catalogue_revision < 9007199254740991),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 0 AND 400),
  changed_at timestamptz NOT NULL,
  changed_by_user_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, revision),
  FOREIGN KEY (tenant_id, catalogue_revision) REFERENCES tenant_catalogue_revisions(tenant_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, changed_by_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE TABLE catering_catalogue_assignment_entries (
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('item', 'package')),
  entry_id varchar(128) NOT NULL CHECK (entry_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  integration_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, revision, kind, entry_id),
  FOREIGN KEY (tenant_id, revision) REFERENCES catering_catalogue_assignment_revisions(tenant_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, integration_id) REFERENCES catering_integration_configurations(tenant_id, integration_id) ON DELETE RESTRICT
);
CREATE TABLE catering_catalogue_assignment_seals (
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (tenant_id, revision),
  FOREIGN KEY (tenant_id, revision) REFERENCES catering_catalogue_assignment_revisions(tenant_id, revision) ON DELETE RESTRICT
);
CREATE TABLE catering_catalogue_assignment_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision >= 1 AND revision < 9007199254740991),
  FOREIGN KEY (tenant_id, revision) REFERENCES catering_catalogue_assignment_seals(tenant_id, revision)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION guard_catering_catalogue_assignment_head()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_ASSIGNMENT_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_catalogue_assignment_head_guard BEFORE UPDATE ON catering_catalogue_assignment_heads
  FOR EACH ROW EXECUTE FUNCTION guard_catering_catalogue_assignment_head();
CREATE TRIGGER catering_catalogue_assignment_revision_append_only BEFORE UPDATE OR DELETE ON catering_catalogue_assignment_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();
CREATE TRIGGER catering_catalogue_assignment_entry_append_only BEFORE UPDATE OR DELETE ON catering_catalogue_assignment_entries
  FOR EACH ROW EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();

CREATE FUNCTION verify_catering_catalogue_assignment_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  catalogue jsonb;
  actual_count integer;
BEGIN
  SELECT snapshot INTO STRICT catalogue FROM public.tenant_catalogue_revisions
    WHERE tenant_id=NEW.tenant_id AND revision=NEW.catalogue_revision;
  IF jsonb_typeof(catalogue->'cateringItems') IS DISTINCT FROM 'array'
    OR jsonb_typeof(catalogue->'cateringPackages') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_SNAPSHOT_INVALID' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO actual_count FROM public.catering_catalogue_assignment_entries
    WHERE tenant_id=NEW.tenant_id AND revision=NEW.revision;
  IF actual_count <> NEW.entry_count
    OR actual_count <> jsonb_array_length(catalogue->'cateringItems') + jsonb_array_length(catalogue->'cateringPackages')
    OR EXISTS (
      SELECT 1 FROM public.catering_catalogue_assignment_entries assignment
      WHERE assignment.tenant_id=NEW.tenant_id AND assignment.revision=NEW.revision AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(catalogue->(CASE assignment.kind WHEN 'item' THEN 'cateringItems'
          ELSE 'cateringPackages' END)) entry WHERE entry->>'id'=assignment.entry_id
      )
    ) THEN RAISE EXCEPTION 'CATERING_CATALOGUE_ASSIGNMENT_INCOMPLETE' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(catalogue->'cateringPackages') bundle
    JOIN public.catering_catalogue_assignment_entries package_assignment ON package_assignment.tenant_id=NEW.tenant_id
      AND package_assignment.revision=NEW.revision AND package_assignment.kind='package'
      AND package_assignment.entry_id=bundle->>'id'
    CROSS JOIN LATERAL jsonb_array_elements_text(bundle->'itemIds') component(item_id)
    LEFT JOIN public.catering_catalogue_assignment_entries item_assignment ON item_assignment.tenant_id=NEW.tenant_id
      AND item_assignment.revision=NEW.revision AND item_assignment.kind='item' AND item_assignment.entry_id=component.item_id
    WHERE item_assignment.integration_id IS NULL OR package_assignment.integration_id <> item_assignment.integration_id
  ) THEN RAISE EXCEPTION 'CATERING_CATALOGUE_PACKAGE_PROVIDER_MISMATCH' USING ERRCODE = '23514'; END IF;
  INSERT INTO public.catering_catalogue_assignment_seals (tenant_id,revision) VALUES (NEW.tenant_id,NEW.revision);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER catering_catalogue_assignment_complete AFTER INSERT ON catering_catalogue_assignment_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_catalogue_assignment_revision();
CREATE FUNCTION guard_catering_catalogue_assignment_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.catering_catalogue_assignment_revisions
    WHERE tenant_id=NEW.tenant_id AND revision=NEW.revision FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.catering_catalogue_assignment_seals
    WHERE tenant_id=NEW.tenant_id AND revision=NEW.revision) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_ASSIGNMENT_REVISION_SEALED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_catalogue_assignment_entry_guard BEFORE INSERT ON catering_catalogue_assignment_entries
  FOR EACH ROW EXECUTE FUNCTION guard_catering_catalogue_assignment_entry();
CREATE TRIGGER catering_catalogue_assignment_seal_append_only BEFORE UPDATE OR DELETE ON catering_catalogue_assignment_seals
  FOR EACH ROW EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();
REVOKE ALL ON FUNCTION guard_catering_catalogue_assignment_head(), verify_catering_catalogue_assignment_revision(),
  guard_catering_catalogue_assignment_entry() FROM PUBLIC;
REVOKE ALL ON TABLE catering_catalogue_assignment_heads, catering_catalogue_assignment_revisions,
  catering_catalogue_assignment_entries, catering_catalogue_assignment_seals FROM PUBLIC;
