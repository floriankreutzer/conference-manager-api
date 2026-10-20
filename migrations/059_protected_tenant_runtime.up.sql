-- Additive private custody only. No existing Tenant, credential or session is classified or activated.
CREATE TABLE protected_runtime_epoch_history (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  security_epoch uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,security_epoch),UNIQUE(environment,revision),UNIQUE(environment,security_epoch,revision),
  CHECK(security_epoch::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
CREATE TABLE protected_runtime_deployments (
  environment varchar(4) PRIMARY KEY CHECK(environment IN ('dev','int','prod')),
  security_epoch uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(security_epoch::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK(updated_at>=created_at),
  FOREIGN KEY(environment,security_epoch,revision)
    REFERENCES protected_runtime_epoch_history(environment,security_epoch,revision) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE protected_runtime_epoch_history ADD CONSTRAINT protected_runtime_epoch_deployment_fk
  FOREIGN KEY(environment) REFERENCES protected_runtime_deployments(environment) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE synthetic_tenant_generations (
  environment varchar(4) NOT NULL REFERENCES protected_runtime_deployments(environment) ON DELETE RESTRICT,
  id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE RESTRICT,
  operator_security_version bigint NOT NULL CHECK(operator_security_version>=1),
  security_epoch uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'preparing' CHECK(state IN ('preparing','active','archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  archived_at timestamptz,
  PRIMARY KEY(environment,id),UNIQUE(environment,id,operator_id),
  CHECK(environment<>'prod'),
  CHECK((state='preparing' AND activated_at IS NULL AND archived_at IS NULL)
    OR (state='active' AND activated_at IS NOT NULL AND activated_at>=created_at AND archived_at IS NULL)
    OR (state='archived' AND archived_at IS NOT NULL AND archived_at>=created_at
      AND (activated_at IS NULL OR (activated_at>=created_at AND archived_at>=activated_at))))
);
CREATE UNIQUE INDEX synthetic_generation_one_active_operator_idx
  ON synthetic_tenant_generations(environment,operator_id) WHERE state='active';
CREATE INDEX synthetic_generation_owner_history_idx ON synthetic_tenant_generations(environment,operator_id,created_at,id);

CREATE TABLE tenant_runtime_registry (
  environment varchar(4) NOT NULL REFERENCES protected_runtime_deployments(environment) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  mode varchar(16) NOT NULL CHECK(mode IN ('real','synthetic')),
  generation_id uuid,
  operator_id uuid,
  slot varchar(16),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,tenant_id),
  UNIQUE(environment,generation_id,slot),
  FOREIGN KEY(environment,generation_id,operator_id)
    REFERENCES synthetic_tenant_generations(environment,id,operator_id) ON DELETE RESTRICT,
  CHECK((mode='real' AND generation_id IS NULL AND operator_id IS NULL AND slot IS NULL)
    OR (mode='synthetic' AND environment<>'prod' AND generation_id IS NOT NULL AND operator_id IS NOT NULL
      AND slot IS NOT NULL AND slot IN ('northwind','contoso','fabrikam')))
);

CREATE FUNCTION protected_runtime_acquire_exclusive(value text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope integer;
BEGIN
  scope:=CASE value WHEN 'dev' THEN 1 WHEN 'int' THEN 2 WHEN 'prod' THEN 3 ELSE NULL END;
  IF scope IS NULL OR NOT pg_try_advisory_xact_lock(740193,scope) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_BUSY' USING ERRCODE='55P03'; END IF;
END $$;
REVOKE ALL ON FUNCTION protected_runtime_acquire_exclusive(text) FROM PUBLIC;

CREATE FUNCTION guard_protected_runtime_deployment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  PERFORM public.protected_runtime_acquire_exclusive(NEW.environment);
  IF TG_OP='UPDATE' AND ((NEW.environment,NEW.created_at) IS DISTINCT FROM (OLD.environment,OLD.created_at)
    OR NEW.security_epoch=OLD.security_epoch OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_DEPLOYMENT_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.revision<>1 THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_DEPLOYMENT_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  INSERT INTO public.protected_runtime_epoch_history(environment,security_epoch,revision)
    VALUES(NEW.environment,NEW.security_epoch,NEW.revision);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_protected_runtime_deployment() FROM PUBLIC;
CREATE TRIGGER protected_runtime_deployment_guard BEFORE INSERT OR UPDATE OR DELETE ON protected_runtime_deployments
  FOR EACH ROW EXECUTE FUNCTION guard_protected_runtime_deployment();

CREATE FUNCTION guard_protected_runtime_epoch_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<>2 THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_EPOCH_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_protected_runtime_epoch_history() FROM PUBLIC;
CREATE TRIGGER protected_runtime_epoch_history_guard BEFORE INSERT OR UPDATE OR DELETE ON protected_runtime_epoch_history
  FOR EACH ROW EXECUTE FUNCTION guard_protected_runtime_epoch_history();

CREATE FUNCTION guard_synthetic_tenant_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  PERFORM public.protected_runtime_acquire_exclusive(NEW.environment);
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'preparing' OR NEW.revision<>1 OR NOT EXISTS(
      SELECT 1 FROM public.platform_operators actor JOIN public.protected_runtime_deployments deployment
        ON deployment.environment=NEW.environment AND deployment.security_epoch=NEW.security_epoch
      WHERE actor.id=NEW.operator_id AND actor.provider='microsoft_entra' AND actor.status='active'
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
      WHERE actor.id=NEW.operator_id AND actor.provider='microsoft_entra' AND actor.status='active'
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
REVOKE ALL ON FUNCTION guard_synthetic_tenant_generation() FROM PUBLIC;
CREATE TRIGGER synthetic_tenant_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON synthetic_tenant_generations
  FOR EACH ROW EXECUTE FUNCTION guard_synthetic_tenant_generation();

CREATE FUNCTION guard_tenant_runtime_registry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'TENANT_RUNTIME_CLASSIFICATION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NEW.mode='synthetic' THEN PERFORM public.protected_runtime_acquire_exclusive(NEW.environment); END IF;
  IF NEW.mode='synthetic' AND NOT EXISTS(SELECT 1 FROM public.synthetic_tenant_generations
    WHERE environment=NEW.environment AND id=NEW.generation_id AND operator_id=NEW.operator_id AND state='preparing') THEN
    RAISE EXCEPTION 'TENANT_RUNTIME_SYNTHETIC_GENERATION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_tenant_runtime_registry() FROM PUBLIC;
CREATE TRIGGER tenant_runtime_registry_guard BEFORE INSERT OR UPDATE OR DELETE ON tenant_runtime_registry
  FOR EACH ROW EXECUTE FUNCTION guard_tenant_runtime_registry();

-- Even an accidentally composed legacy Demo reset may not erase populated
-- protected custody. The definer can only inspect this exact fixed trigger path.
CREATE FUNCTION guard_protected_runtime_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'TRUNCATE' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT' OR pg_trigger_depth()<>1
    OR TG_NAME<>'protected_runtime_truncate_guard'
    OR TG_RELID NOT IN ('public.tenant_runtime_registry'::regclass,'public.synthetic_tenant_generations'::regclass,
      'public.protected_runtime_deployments'::regclass,'public.protected_runtime_epoch_history'::regclass) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_TRUNCATE_CONTEXT_INVALID' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_runtime_registry LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.synthetic_tenant_generations LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.protected_runtime_deployments LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.protected_runtime_epoch_history LIMIT 1) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_CUSTODY_NOT_RESETTABLE' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_protected_runtime_truncate() FROM PUBLIC;
CREATE TRIGGER protected_runtime_truncate_guard BEFORE TRUNCATE ON tenant_runtime_registry
  FOR EACH STATEMENT EXECUTE FUNCTION guard_protected_runtime_truncate();
CREATE TRIGGER protected_runtime_truncate_guard BEFORE TRUNCATE ON synthetic_tenant_generations
  FOR EACH STATEMENT EXECUTE FUNCTION guard_protected_runtime_truncate();
CREATE TRIGGER protected_runtime_truncate_guard BEFORE TRUNCATE ON protected_runtime_deployments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_protected_runtime_truncate();
CREATE TRIGGER protected_runtime_truncate_guard BEFORE TRUNCATE ON protected_runtime_epoch_history
  FOR EACH STATEMENT EXECUTE FUNCTION guard_protected_runtime_truncate();
