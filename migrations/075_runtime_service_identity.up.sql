ALTER TABLE platform_runtime_deployments
  ADD COLUMN service_instance_key VARCHAR(64),
  ADD COLUMN service_surface VARCHAR(16),
  ADD CONSTRAINT platform_runtime_service_identity_valid CHECK (
    (service_instance_key IS NULL AND service_surface IS NULL)
    OR (service_instance_key IS NOT NULL AND service_surface IS NOT NULL
      AND service_instance_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND service_surface IN ('customer','platform','shared'))
  );

-- Legacy observations have no proven instance identity. Never guess one from
-- a deployment hash or environment. Once attributed, the identity is immutable.
CREATE FUNCTION protect_platform_runtime_service_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.service_instance_key IS NOT NULL AND
    ROW(NEW.service_instance_key,NEW.service_surface)
      IS DISTINCT FROM ROW(OLD.service_instance_key,OLD.service_surface) THEN
    RAISE EXCEPTION 'PLATFORM_RUNTIME_SERVICE_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION protect_platform_runtime_service_identity() FROM PUBLIC;
CREATE TRIGGER platform_runtime_service_identity_protected
  BEFORE UPDATE ON platform_runtime_deployments
  FOR EACH ROW EXECUTE FUNCTION protect_platform_runtime_service_identity();
