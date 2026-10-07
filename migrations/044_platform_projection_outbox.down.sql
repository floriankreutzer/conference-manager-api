LOCK TABLE platform_projection_outbox IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform_projection_outbox LIMIT 1) THEN
    RAISE EXCEPTION 'PLATFORM_PROJECTION_OUTBOX_ROLLBACK_REQUIRES_DRAIN' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TRIGGER capability_health_projection_outbox ON microsoft365_capability_health;
DROP TRIGGER room_mappings_projection_outbox ON microsoft365_room_mappings;
DROP TRIGGER entitlements_projection_outbox ON tenant_entitlements;
DROP TRIGGER integrations_projection_outbox ON integrations;
DROP TRIGGER onboarding_invitations_projection_outbox ON tenant_onboarding_invitations;
DROP TRIGGER identity_bindings_projection_outbox ON tenant_identity_bindings;
DROP TRIGGER tenants_projection_outbox ON tenants;
DROP FUNCTION enqueue_platform_projection_invalidation();
DROP TABLE platform_projection_outbox;
