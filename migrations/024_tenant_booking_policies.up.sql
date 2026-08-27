CREATE TABLE tenant_booking_policy_configuration (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  configuration JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor_user_id UUID,
  CONSTRAINT tenant_booking_policy_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT tenant_booking_policy_configuration_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES users(tenant_id, id)
    ON DELETE RESTRICT
);

INSERT INTO tenant_booking_policy_configuration (tenant_id, configuration)
SELECT
  id,
  '{
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
FROM tenants;

CREATE FUNCTION provision_tenant_booking_policy_configuration()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO tenant_booking_policy_configuration (tenant_id, configuration)
  VALUES (
    NEW.id,
    '{
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
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_provision_booking_policy_configuration
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION provision_tenant_booking_policy_configuration();

CREATE TABLE tenant_booking_policy_revisions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  configuration JSONB NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  actor_user_id UUID NOT NULL,
  PRIMARY KEY (tenant_id, revision),
  CONSTRAINT tenant_booking_policy_revisions_revision_positive
    CHECK (revision >= 1),
  CONSTRAINT tenant_booking_policy_revisions_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT tenant_booking_policy_revisions_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES users(tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX tenant_booking_policy_revisions_tenant_changed_idx
  ON tenant_booking_policy_revisions (tenant_id, changed_at DESC, revision DESC);

CREATE FUNCTION reject_tenant_booking_policy_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'tenant_booking_policy_revisions are immutable';
END;
$$;

CREATE TRIGGER tenant_booking_policy_revisions_immutable_update
BEFORE UPDATE ON tenant_booking_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_tenant_booking_policy_revision_mutation();

CREATE TRIGGER tenant_booking_policy_revisions_immutable_delete
BEFORE DELETE ON tenant_booking_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_tenant_booking_policy_revision_mutation();
