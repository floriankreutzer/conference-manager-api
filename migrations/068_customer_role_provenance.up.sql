-- Existing role rows remain effective role rows, with explicit grant provenance.
-- No Microsoft grant is created by this migration.
ALTER TABLE tenant_user_roles
  ADD COLUMN direct_grant boolean NOT NULL DEFAULT true,
  ADD COLUMN microsoft_directory_id uuid,
  ADD COLUMN microsoft_group_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];
CREATE FUNCTION tenant_role_group_sources_valid(values_input uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT cardinality(values_input)<=200 AND array_ndims(values_input) IS NOT DISTINCT FROM
    CASE WHEN cardinality(values_input)=0 THEN NULL::integer ELSE 1 END
    AND array_position(values_input,NULL::uuid) IS NULL
    AND cardinality(values_input)=(SELECT count(DISTINCT entry) FROM unnest(values_input) entry)
$$;
REVOKE ALL ON FUNCTION tenant_role_group_sources_valid(uuid[]) FROM PUBLIC;
-- CHECK execution needs the fixed pure validator, not table or provider authority.
GRANT EXECUTE ON FUNCTION tenant_role_group_sources_valid(uuid[]) TO PUBLIC;
ALTER TABLE tenant_user_roles
  ADD CONSTRAINT tenant_role_group_sources_valid CHECK(tenant_role_group_sources_valid(microsoft_group_ids)),
  ADD CONSTRAINT tenant_role_group_directory_valid CHECK(
    (cardinality(microsoft_group_ids)=0 AND microsoft_directory_id IS NULL)
    OR (cardinality(microsoft_group_ids)>0 AND microsoft_directory_id IS NOT NULL)),
  ADD CONSTRAINT tenant_role_has_source CHECK(direct_grant OR cardinality(microsoft_group_ids)>0);

CREATE FUNCTION invalidate_tenant_group_role_sessions() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE affected_tenant uuid; affected_user uuid; changed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    affected_tenant:=NEW.tenant_id; affected_user:=NEW.user_id; changed:=cardinality(NEW.microsoft_group_ids)>0;
  ELSIF TG_OP='DELETE' THEN
    affected_tenant:=OLD.tenant_id; affected_user:=OLD.user_id; changed:=cardinality(OLD.microsoft_group_ids)>0;
  ELSE
    IF (NEW.tenant_id,NEW.user_id,NEW.role) IS DISTINCT FROM (OLD.tenant_id,OLD.user_id,OLD.role)
      AND (cardinality(NEW.microsoft_group_ids)>0 OR cardinality(OLD.microsoft_group_ids)>0) THEN
      RAISE EXCEPTION 'TENANT_GROUP_ROLE_IDENTITY_IMMUTABLE' USING ERRCODE='42501';
    END IF;
    affected_tenant:=NEW.tenant_id; affected_user:=NEW.user_id;
    changed:=(NEW.microsoft_directory_id,NEW.microsoft_group_ids) IS DISTINCT FROM
      (OLD.microsoft_directory_id,OLD.microsoft_group_ids);
  END IF;
  IF changed THEN
    UPDATE public.users SET security_version=security_version+1,updated_at=clock_timestamp()
      WHERE tenant_id=affected_tenant AND id=affected_user;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION invalidate_tenant_group_role_sessions() FROM PUBLIC;
CREATE TRIGGER tenant_group_role_session_invalidation AFTER INSERT OR UPDATE OR DELETE ON tenant_user_roles
  FOR EACH ROW EXECUTE FUNCTION invalidate_tenant_group_role_sessions();
