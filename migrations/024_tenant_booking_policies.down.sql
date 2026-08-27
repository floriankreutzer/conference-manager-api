LOCK TABLE tenant_booking_policy_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_booking_policy_configuration IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_booking_policy_revisions LIMIT 1)
     OR EXISTS (
       SELECT 1
       FROM tenants
       WHERE booking_policies_revision <> 1
       LIMIT 1
     )
     OR EXISTS (
       SELECT 1
       FROM tenant_booking_policy_configuration
       WHERE actor_user_id IS NOT NULL
          OR configuration <> '{
            "versions": [{
              "id": "platform-default-v1",
              "effectiveFrom": "1970-01-01T00:00:00.000Z",
              "rules": {
                "minimumLeadTimeMinutes": 0,
                "maximumAdvanceMinutes": 527040,
                "cancellationWindowMinutes": 0,
                "changeWindowMinutes": 0,
                "maximumParticipants": 100000,
                "allowedSiteIds": [],
                "allowedRoomIds": [],
                "allowedServiceIds": []
              }
            }]
          }'::jsonb
       LIMIT 1
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_BOOKING_POLICIES_REQUIRE_REVIEW';
  END IF;
END
$$;

DROP TRIGGER tenant_booking_policy_revisions_immutable_delete
  ON tenant_booking_policy_revisions;
DROP TRIGGER tenant_booking_policy_revisions_immutable_update
  ON tenant_booking_policy_revisions;
DROP FUNCTION reject_tenant_booking_policy_revision_mutation();
DROP TABLE tenant_booking_policy_revisions;

DROP TRIGGER tenants_provision_booking_policy_configuration ON tenants;
DROP FUNCTION provision_tenant_booking_policy_configuration();
DROP TABLE tenant_booking_policy_configuration;
