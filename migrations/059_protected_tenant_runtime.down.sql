DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM tenant_runtime_registry LIMIT 1)
    OR EXISTS(SELECT 1 FROM synthetic_tenant_generations LIMIT 1)
    OR EXISTS(SELECT 1 FROM protected_runtime_deployments LIMIT 1)
    OR EXISTS(SELECT 1 FROM protected_runtime_epoch_history LIMIT 1) THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TABLE tenant_runtime_registry;
DROP TABLE synthetic_tenant_generations;
ALTER TABLE protected_runtime_epoch_history DROP CONSTRAINT protected_runtime_epoch_deployment_fk;
DROP TABLE protected_runtime_deployments;
DROP TABLE protected_runtime_epoch_history;
DROP FUNCTION guard_tenant_runtime_registry();
DROP FUNCTION guard_synthetic_tenant_generation();
DROP FUNCTION guard_protected_runtime_deployment();
DROP FUNCTION guard_protected_runtime_epoch_history();
DROP FUNCTION guard_protected_runtime_truncate();
DROP FUNCTION protected_runtime_acquire_exclusive(text);
