LOCK TABLE platform_audit_segments IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM platform_audit_segments) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000';
  END IF;
END $$;
DROP TRIGGER platform_audit_handoff_segment ON synthetic_customer_handoffs;
DROP FUNCTION guard_platform_audit_handoff_segment();
DROP TRIGGER platform_audit_segment_genesis ON platform_audit_segments;
DROP FUNCTION require_platform_audit_segment_genesis();
DROP TRIGGER platform_audit_segment_head ON platform_audit_segment_heads;
DROP FUNCTION guard_platform_audit_segment_head();
DROP TRIGGER platform_audit_segment_checkpoint ON platform_audit_segment_checkpoints;
DROP FUNCTION guard_platform_audit_segment_checkpoint();
DROP TRIGGER platform_audit_segment_truncate ON platform_audit_events;
DROP TRIGGER platform_audit_segment_checkpoint_truncate ON platform_audit_checkpoints;
DROP TRIGGER platform_audit_segment_legacy_head_truncate ON platform_audit_chain_state;
DROP TRIGGER platform_audit_segment_metadata_truncate ON platform_audit_segments;
DROP TRIGGER platform_audit_segment_head_truncate ON platform_audit_segment_heads;
DROP TRIGGER platform_audit_segment_new_checkpoint_truncate ON platform_audit_segment_checkpoints;
DROP TRIGGER platform_audit_frozen_head ON platform_audit_chain_state;
DROP TRIGGER platform_audit_frozen_checkpoint ON platform_audit_checkpoints;
DROP FUNCTION guard_platform_audit_frozen_head();
DROP TRIGGER platform_audit_segment_event ON platform_audit_events;
DROP FUNCTION guard_platform_audit_segment_event();
DROP TRIGGER platform_audit_segment_creation ON platform_audit_segments;
DROP FUNCTION guard_platform_audit_segment_creation();
DROP FUNCTION platform_legacy_audit_inventory();
DROP TABLE platform_audit_segment_checkpoints;
DROP TABLE platform_audit_segment_heads;
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_integrity_version_valid;
ALTER TABLE platform_audit_events DROP COLUMN segment_id;
ALTER TABLE platform_audit_events DROP COLUMN segment_sequence;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_integrity_version_valid CHECK (integrity_version=1);
DROP TABLE platform_audit_segments;
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_actor_snapshot_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_actor_snapshot_valid CHECK (
  (operator_id IS NULL AND cardinality(roles)=0 AND cardinality(permissions)=0
    AND ((action='platform.authentication.failed' AND assurance_level='unverified')
      OR (action='platform.operator.changed' AND assurance_level='offline_owner' AND target_tenant_id IS NULL
        AND target_type IN ('platform_passkey_grant','platform_operator_bootstrap') AND retention_class='recovery' AND outcome='success')))
  OR (operator_id IS NOT NULL AND platform_roles_are_canonical(roles)
    AND permissions=platform_permissions_for_roles(roles) AND assurance_level IN ('mfa','step_up','break_glass')));
