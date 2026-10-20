DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.tenant_runtime_registry,public.synthetic_tenant_generations,public.protected_runtime_deployments,public.protected_runtime_epoch_history FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
