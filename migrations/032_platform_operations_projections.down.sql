LOCK TABLE platform_recovery_contexts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_microsoft_reconsent_handoffs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_diagnostic_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_audit_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_microsoft_fleet_capabilities IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_microsoft_fleet_snapshots IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_tenant_readiness_evidence IN ACCESS EXCLUSIVE MODE;
LOCK TABLE microsoft365_room_discovery_observations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE platform_tenant_readiness_snapshots IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_recovery_contexts LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_microsoft_reconsent_handoffs LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_diagnostic_events LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_microsoft_fleet_capabilities LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_microsoft_fleet_snapshots LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_tenant_readiness_evidence LIMIT 1)
     OR EXISTS (SELECT 1 FROM microsoft365_room_discovery_observations LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_tenant_readiness_snapshots LIMIT 1) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATIONS_PROJECTIONS_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER platform_reconsent_handoffs_protected ON platform_microsoft_reconsent_handoffs;
DROP FUNCTION protect_platform_reconsent_handoff();
DROP TRIGGER platform_recovery_contexts_protected ON platform_recovery_contexts;
DROP FUNCTION protect_platform_recovery_context();
DROP TRIGGER platform_diagnostic_events_protected ON platform_diagnostic_events;
DROP FUNCTION protect_platform_diagnostic_event();
DROP TRIGGER platform_audit_events_diagnostic_projection ON platform_audit_events;
DROP FUNCTION project_platform_audit_diagnostic_event();
DROP TRIGGER audit_events_diagnostic_projection ON audit_events;
DROP FUNCTION project_tenant_audit_diagnostic_event();
DROP TRIGGER tenants_invalidate_platform_operational_snapshots ON tenants;
DROP FUNCTION invalidate_platform_tenant_operational_snapshots();
DROP TRIGGER platform_microsoft_snapshots_revision_guard ON platform_microsoft_fleet_snapshots;
DROP TRIGGER platform_readiness_evidence_immutable ON platform_tenant_readiness_evidence;
DROP FUNCTION protect_platform_readiness_evidence();
DROP TRIGGER platform_readiness_snapshots_revision_guard ON platform_tenant_readiness_snapshots;
DROP FUNCTION protect_platform_operational_projection();

DROP INDEX platform_reconsent_handoff_active_idx;
DROP TABLE platform_microsoft_reconsent_handoffs;
DROP INDEX platform_recovery_context_retention_idx;
DROP INDEX platform_recovery_context_active_idx;
DROP TABLE platform_recovery_contexts;
DROP INDEX platform_diagnostic_event_retention_idx;
DROP INDEX platform_diagnostic_event_failures_idx;
DROP INDEX platform_diagnostic_event_correlation_idx;
DROP TABLE platform_diagnostic_events;
DROP INDEX platform_microsoft_capability_filter_idx;
DROP TABLE platform_microsoft_fleet_capabilities;
DROP TRIGGER microsoft365_room_discovery_observations_revision_guard
  ON microsoft365_room_discovery_observations;
DROP FUNCTION protect_microsoft365_room_discovery_observation();
DROP INDEX microsoft365_room_observation_repair_idx;
DROP TABLE microsoft365_room_discovery_observations;
DROP INDEX platform_microsoft_snapshot_connection_idx;
DROP TABLE platform_microsoft_fleet_snapshots;
DROP INDEX platform_readiness_evidence_release_idx;
DROP TABLE platform_tenant_readiness_evidence;
DROP INDEX platform_readiness_snapshot_blockers_idx;
DROP INDEX platform_readiness_snapshot_fleet_idx;
DROP TABLE platform_tenant_readiness_snapshots;
