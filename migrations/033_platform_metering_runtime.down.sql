LOCK TABLE platform_runtime_tenant_mappings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_runtime_deployments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_quota_operation_receipts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_operational_quotas IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_metering_period_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_metering_periods IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_metering_events IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_metering_events LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_metering_periods LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_metering_period_revisions LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_operational_quotas LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_quota_operation_receipts LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_runtime_deployments LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_runtime_tenant_mappings LIMIT 1) THEN
    RAISE EXCEPTION 'PLATFORM_METERING_RUNTIME_ROLLBACK_REQUIRES_REVIEW'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER platform_runtime_tenant_mappings_protected ON platform_runtime_tenant_mappings;
DROP FUNCTION protect_platform_runtime_tenant_mapping();
DROP TRIGGER platform_runtime_deployments_protected ON platform_runtime_deployments;
DROP FUNCTION protect_platform_runtime_deployment();
DROP TRIGGER platform_quota_operation_receipts_protected ON platform_quota_operation_receipts;
DROP FUNCTION protect_platform_quota_receipt();
DROP TRIGGER platform_operational_quotas_protected ON platform_operational_quotas;
DROP FUNCTION protect_platform_operational_quota();
DROP TRIGGER platform_metering_periods_protected ON platform_metering_periods;
DROP FUNCTION protect_platform_metering_period();
DROP TRIGGER platform_metering_period_revisions_protected
  ON platform_metering_period_revisions;
DROP FUNCTION protect_platform_metering_period_revision();
DROP TRIGGER platform_metering_events_protected ON platform_metering_events;
DROP FUNCTION protect_platform_metering_event();

DROP INDEX platform_runtime_tenant_mappings_deployment_idx;
DROP TABLE platform_runtime_tenant_mappings;
DROP INDEX platform_runtime_deployments_retention_idx;
DROP INDEX platform_runtime_deployments_observation_idx;
DROP INDEX platform_runtime_deployments_approved_idx;
DROP TABLE platform_runtime_deployments;
DROP INDEX platform_quota_operation_receipts_retention_idx;
DROP TABLE platform_quota_operation_receipts;
DROP INDEX platform_operational_quotas_state_idx;
DROP TABLE platform_operational_quotas;
DROP INDEX platform_metering_periods_retention_idx;
DROP INDEX platform_metering_periods_state_idx;
DROP TABLE platform_metering_periods;
DROP INDEX platform_metering_period_revisions_retention_idx;
DROP TABLE platform_metering_period_revisions;
DROP INDEX platform_metering_events_retention_idx;
DROP INDEX platform_metering_events_period_dimension_idx;
DROP TABLE platform_metering_events;
DROP FUNCTION platform_runtime_reference_is_valid(TEXT, INTEGER);
DROP FUNCTION platform_runtime_support_identifier_is_valid(TEXT);
DROP FUNCTION platform_metering_period_is_utc_month(TIMESTAMPTZ, TIMESTAMPTZ);
