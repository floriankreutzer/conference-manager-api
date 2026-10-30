LOCK TABLE platform_runtime_deployments IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM platform_runtime_deployments WHERE service_instance_key IS NOT NULL) THEN
    RAISE EXCEPTION 'PLATFORM_RUNTIME_SERVICE_IDENTITY_RETAINED' USING ERRCODE='55000';
  END IF;
END;
$$;
DROP TRIGGER platform_runtime_service_identity_protected ON platform_runtime_deployments;
DROP FUNCTION protect_platform_runtime_service_identity();
ALTER TABLE platform_runtime_deployments
  DROP CONSTRAINT platform_runtime_service_identity_valid,
  DROP COLUMN service_instance_key,
  DROP COLUMN service_surface;
