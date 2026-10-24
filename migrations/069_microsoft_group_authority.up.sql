-- No observed membership may be fabricated from pre-existing provenance.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM tenant_user_roles WHERE cardinality(microsoft_group_ids)>0) THEN
    RAISE EXCEPTION 'MICROSOFT_ROLE_FRESH_OBSERVATION_REQUIRED' USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE tenant_user_roles ADD COLUMN microsoft_verified_until timestamptz,
  ADD CONSTRAINT tenant_role_group_expiry_valid CHECK(
    (cardinality(microsoft_group_ids)=0 AND microsoft_verified_until IS NULL)
    OR (cardinality(microsoft_group_ids)>0 AND microsoft_verified_until IS NOT NULL));

-- Pure source-validity predicate: no table access or credential authority.
CREATE FUNCTION tenant_role_source_active(direct_source boolean,verified_until timestamptz) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT direct_source OR verified_until>clock_timestamp()
$$;
REVOKE ALL ON FUNCTION tenant_role_source_active(boolean,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_role_source_active(boolean,timestamptz) TO PUBLIC;

CREATE FUNCTION invalidate_tenant_group_role_refresh() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF (OLD.microsoft_directory_id,OLD.microsoft_group_ids) IS NOT DISTINCT FROM
    (NEW.microsoft_directory_id,NEW.microsoft_group_ids)
    AND (OLD.microsoft_verified_until IS DISTINCT FROM NEW.microsoft_verified_until
      OR cardinality(NEW.microsoft_group_ids)>0) THEN
    -- A verified refresh is a new source snapshot even if second-granularity
    -- provider expiry and identical membership produce the same deadline.
    UPDATE public.users SET security_version=security_version+1,updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION invalidate_tenant_group_role_refresh() FROM PUBLIC;
CREATE TRIGGER tenant_group_role_refresh AFTER UPDATE OF microsoft_verified_until ON tenant_user_roles
  FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_group_role_refresh();

CREATE FUNCTION tenant_microsoft_role_mappings_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE entry jsonb; previous_ids text[]:=ARRAY[]::text[]; roles jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value)>100 OR octet_length(value::text)>32768 THEN RETURN false; END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(value) item LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR ARRAY(SELECT jsonb_object_keys(entry) ORDER BY 1)<>ARRAY['groupId','roles'] THEN RETURN false; END IF;
    IF jsonb_typeof(entry->'groupId') IS DISTINCT FROM 'string'
      OR entry->>'groupId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      OR entry->>'groupId'=ANY(previous_ids) THEN RETURN false; END IF;
    previous_ids:=array_append(previous_ids,entry->>'groupId');roles:=entry->'roles';
    IF roles NOT IN ('["conference_manager"]'::jsonb,'["tenant_admin"]'::jsonb,
      '["conference_manager","tenant_admin"]'::jsonb) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_microsoft_role_mappings_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_microsoft_role_mappings_valid(jsonb) TO PUBLIC;
CREATE TABLE tenant_microsoft_role_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
  directory_id uuid NOT NULL CHECK(directory_id<>'9188040d-6c67-4c5b-b112-36a304b66dad'::uuid),
  mappings jsonb NOT NULL CHECK(tenant_microsoft_role_mappings_valid(mappings)),
  approved_by_user_id uuid NOT NULL,
  audit_event_id bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,approved_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,audit_event_id) REFERENCES audit_events(tenant_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON tenant_microsoft_role_settings FROM PUBLIC;

CREATE TABLE customer_microsoft_group_observations (
  environment varchar(4) NOT NULL,
  flow_id uuid NOT NULL,
  directory_id uuid NOT NULL,
  provider_user_id uuid NOT NULL,
  status varchar(16) NOT NULL CHECK(status IN ('complete','unavailable','overage')),
  group_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[] CHECK(tenant_role_group_sources_valid(group_ids)),
  verified_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  PRIMARY KEY(environment,flow_id),
  FOREIGN KEY(environment,flow_id) REFERENCES customer_microsoft_flows(environment,id) ON DELETE CASCADE,
  CHECK(status='complete' OR cardinality(group_ids)=0),
  CHECK(valid_until>verified_at AND valid_until<=verified_at+interval '1 hour')
);
REVOKE ALL ON customer_microsoft_group_observations FROM PUBLIC;
CREATE FUNCTION guard_customer_microsoft_group_observation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'MICROSOFT_GROUP_OBSERVATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.customer_microsoft_flows flow
    WHERE flow.environment=NEW.environment AND flow.id=NEW.flow_id AND flow.status='verified'
      AND flow.provider_tenant_reference=NEW.directory_id AND flow.provider_user_reference=NEW.provider_user_id
      AND flow.verified_at=NEW.verified_at AND NEW.valid_until>clock_timestamp()) THEN
    RAISE EXCEPTION 'MICROSOFT_GROUP_OBSERVATION_BINDING_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_customer_microsoft_group_observation() FROM PUBLIC;
CREATE TRIGGER customer_microsoft_group_observation_insert BEFORE INSERT OR UPDATE ON customer_microsoft_group_observations
  FOR EACH ROW EXECUTE FUNCTION guard_customer_microsoft_group_observation();

-- Closed Demo reset must name all FK participants, even when empty. A strictly
-- bound read-only definer guard prevents that reset from erasing real authority.
CREATE FUNCTION guard_empty_microsoft_role_authority_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'TRUNCATE' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT'
    OR TG_NAME<>'microsoft_role_authority_empty_reset_guard' OR pg_trigger_depth()<>1
    OR TG_RELID NOT IN ('public.tenant_microsoft_role_settings'::regclass,
      'public.customer_microsoft_group_observations'::regclass) THEN
    RAISE EXCEPTION 'MICROSOFT_ROLE_RESET_CONTEXT_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF TG_RELID='public.tenant_microsoft_role_settings'::regclass THEN
    IF EXISTS(SELECT 1 FROM public.tenant_microsoft_role_settings) THEN
      RAISE EXCEPTION 'MICROSOFT_ROLE_AUTHORITY_RESET_DENIED' USING ERRCODE='55000';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM public.customer_microsoft_group_observations) THEN
    RAISE EXCEPTION 'MICROSOFT_ROLE_AUTHORITY_RESET_DENIED' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_empty_microsoft_role_authority_truncate() FROM PUBLIC;
CREATE TRIGGER microsoft_role_authority_empty_reset_guard BEFORE TRUNCATE ON tenant_microsoft_role_settings
  FOR EACH STATEMENT EXECUTE FUNCTION guard_empty_microsoft_role_authority_truncate();
CREATE TRIGGER microsoft_role_authority_empty_reset_guard BEFORE TRUNCATE ON customer_microsoft_group_observations
  FOR EACH STATEMENT EXECUTE FUNCTION guard_empty_microsoft_role_authority_truncate();
