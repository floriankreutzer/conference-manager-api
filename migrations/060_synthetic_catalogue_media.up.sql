-- Additive private synthetic business storage; no Tenant is classified or provisioned.
CREATE TABLE synthetic_catalogue_media_assets (
  tenant_id uuid NOT NULL REFERENCES tenant_runtime_registry(tenant_id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  owner_kind varchar(20) NOT NULL CHECK(owner_kind IN ('room_plan','catering_package','catering_item')),
  owner_id varchar(128) NOT NULL,
  room_id varchar(128) GENERATED ALWAYS AS (CASE WHEN owner_kind='room_plan' THEN owner_id END) STORED,
  catering_package_id varchar(128) GENERATED ALWAYS AS (CASE WHEN owner_kind='catering_package' THEN owner_id END) STORED,
  catering_item_id varchar(128) GENERATED ALWAYS AS (CASE WHEN owner_kind='catering_item' THEN owner_id END) STORED,
  bytes bytea,
  object_key varchar(192),
  content_type varchar(16) NOT NULL CHECK(content_type IN ('image/png','image/webp')),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 32 AND 2097152),
  content_sha256 bytea NOT NULL CHECK(octet_length(content_sha256)=32),
  alt_text varchar(160) NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_kind,owner_id),
  FOREIGN KEY(tenant_id,created_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,room_id) REFERENCES rooms(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,catering_package_id) REFERENCES catering_packages(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,catering_item_id) REFERENCES catering_items(tenant_id,id) ON DELETE RESTRICT,
  CHECK((bytes IS NOT NULL OR object_key IS NOT NULL) AND (bytes IS NULL OR octet_length(bytes)=byte_length)),
  CHECK(object_key IS NULL OR object_key='v1/' || tenant_id::text || '/catalogue/' || id::text || '/' || encode(content_sha256,'hex'))
);
REVOKE ALL ON TABLE synthetic_catalogue_media_assets FROM PUBLIC;

CREATE FUNCTION guard_synthetic_catalogue_media() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope text;target_tenant uuid;
BEGIN
  IF TG_OP='DELETE' THEN target_tenant:=OLD.tenant_id;
  ELSE
    target_tenant:=NEW.tenant_id;
    IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.id,NEW.owner_kind,NEW.owner_id,NEW.created_at,NEW.created_by_user_id)
        IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.owner_kind,OLD.owner_id,OLD.created_at,OLD.created_by_user_id) THEN
      RAISE EXCEPTION 'SYNTHETIC_MEDIA_OWNERSHIP_IMMUTABLE' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT environment INTO scope FROM public.tenant_runtime_registry WHERE tenant_id=target_tenant AND mode='synthetic';
  IF scope NOT IN ('dev','int') OR scope IS NULL OR NOT pg_try_advisory_xact_lock_shared(740193,CASE scope WHEN 'dev' THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'SYNTHETIC_MEDIA_SCOPE_DENIED' USING ERRCODE='23514'; END IF;
  -- Row locks recheck an intervening reset/epoch/owner change after the initial
  -- statement snapshot. RR serialization failures remain failures, never retries.
  PERFORM 1 FROM public.tenant_runtime_registry registry
    JOIN public.synthetic_tenant_generations generation ON generation.environment=registry.environment
      AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=registry.environment
      AND deployment.security_epoch=generation.security_epoch
    JOIN public.platform_operators actor ON actor.id=registry.operator_id
      AND actor.security_version=generation.operator_security_version
    JOIN public.tenants tenant ON tenant.id=registry.tenant_id
    WHERE registry.tenant_id=target_tenant AND registry.mode='synthetic' AND registry.environment=scope
      AND generation.state IN ('preparing','active') AND actor.provider='microsoft_entra_platform' AND actor.status='active'
      AND tenant.status IN ('onboarding','ready','active')
    FOR SHARE OF generation,deployment,actor,tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHETIC_MEDIA_SCOPE_DENIED' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_catalogue_media() FROM PUBLIC;
CREATE TRIGGER synthetic_catalogue_media_guard BEFORE INSERT OR UPDATE OR DELETE ON synthetic_catalogue_media_assets
  FOR EACH ROW EXECUTE FUNCTION guard_synthetic_catalogue_media();

CREATE FUNCTION guard_synthetic_catalogue_media_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'TRUNCATE' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT' OR pg_trigger_depth()<>1 OR TG_NARGS<>0
    OR TG_RELID<>'public.synthetic_catalogue_media_assets'::regclass THEN
    RAISE EXCEPTION 'SYNTHETIC_MEDIA_TRUNCATE_TRIGGER_SCOPE_INVALID' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.synthetic_catalogue_media_assets LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_BUSINESS_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_catalogue_media_truncate() FROM PUBLIC;
CREATE TRIGGER synthetic_catalogue_media_truncate_guard BEFORE TRUNCATE ON synthetic_catalogue_media_assets
  FOR EACH STATEMENT EXECUTE FUNCTION guard_synthetic_catalogue_media_truncate();

-- Align existing generation custody with the actual Platform primary provider.
-- Accepted059 source/checksum is immutable; Customer provider identities stay separate.
CREATE OR REPLACE FUNCTION guard_synthetic_tenant_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  PERFORM public.protected_runtime_acquire_exclusive(NEW.environment);
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'preparing' OR NEW.revision<>1 OR NOT EXISTS(
      SELECT 1 FROM public.platform_operators actor JOIN public.protected_runtime_deployments deployment
        ON deployment.environment=NEW.environment AND deployment.security_epoch=NEW.security_epoch
      WHERE actor.id=NEW.operator_id AND actor.provider='microsoft_entra_platform' AND actor.status='active'
        AND actor.security_version=NEW.operator_security_version)
      OR (SELECT count(*) FROM public.synthetic_tenant_generations
        WHERE environment=NEW.environment AND operator_id=NEW.operator_id)>=32 THEN
      RAISE EXCEPTION 'SYNTHETIC_GENERATION_CREATION_DENIED' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.environment,NEW.id,NEW.operator_id,NEW.operator_security_version,NEW.security_epoch,NEW.created_at)
      IS DISTINCT FROM (OLD.environment,OLD.id,OLD.operator_id,OLD.operator_security_version,OLD.security_epoch,OLD.created_at)
    OR NEW.revision<>OLD.revision+1
    OR NOT ((OLD.state='preparing' AND NEW.state IN ('active','archived')) OR (OLD.state='active' AND NEW.state='archived'))
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.state='preparing' AND NEW.state='archived' AND NEW.activated_at IS NOT NULL)
    OR NEW.activated_at>clock_timestamp()+interval '1 second' OR NEW.archived_at>clock_timestamp()+interval '1 second' THEN
    RAISE EXCEPTION 'SYNTHETIC_GENERATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  IF NEW.state='active' THEN
    IF NOT EXISTS(SELECT 1 FROM public.platform_operators actor JOIN public.protected_runtime_deployments deployment
      ON deployment.environment=NEW.environment AND deployment.security_epoch=NEW.security_epoch
      WHERE actor.id=NEW.operator_id AND actor.provider='microsoft_entra_platform' AND actor.status='active'
        AND actor.security_version=NEW.operator_security_version)
      OR (SELECT count(*) FROM public.tenant_runtime_registry registry JOIN public.tenants tenant ON tenant.id=registry.tenant_id
        WHERE registry.environment=NEW.environment AND registry.generation_id=NEW.id
          AND tenant.status IN ('onboarding','ready','active'))<>3 THEN
      RAISE EXCEPTION 'SYNTHETIC_GENERATION_ACTIVATION_DENIED' USING ERRCODE='23514'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.tenant_runtime_registry registry JOIN public.tenants tenant ON tenant.id=registry.tenant_id
    WHERE registry.environment=NEW.environment AND registry.generation_id=NEW.id AND tenant.status<>'archived') THEN
    RAISE EXCEPTION 'SYNTHETIC_GENERATION_REQUIRES_TENANT_ARCHIVAL' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
