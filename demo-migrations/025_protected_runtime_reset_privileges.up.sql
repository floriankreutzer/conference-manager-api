-- Only the closed synthetic Demo can truncate these empty private tables.
-- Protected INT never composes the Demo runtime/reset authority.
DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.tenant_runtime_registry,public.synthetic_tenant_generations,public.protected_runtime_deployments,public.protected_runtime_epoch_history FROM %I,%I,%I',customer_role,platform_role,reset_role);
  EXECUTE format('GRANT TRUNCATE ON TABLE public.tenant_runtime_registry,public.synthetic_tenant_generations,public.protected_runtime_deployments,public.protected_runtime_epoch_history TO %I',reset_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.protected_runtime_acquire_exclusive(text),public.guard_protected_runtime_deployment(),public.guard_protected_runtime_epoch_history(),public.guard_synthetic_tenant_generation(),public.guard_tenant_runtime_registry(),public.guard_protected_runtime_truncate() FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
