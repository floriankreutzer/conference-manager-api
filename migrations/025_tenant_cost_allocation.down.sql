LOCK TABLE tenant_cost_allocation_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_cost_centers IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_cost_allocation_configuration IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_cost_allocation_revisions LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenant_cost_centers LIMIT 1)
     OR EXISTS (
       SELECT 1
       FROM tenant_cost_allocation_configuration
       WHERE allocation_required = TRUE
       LIMIT 1
     )
     OR EXISTS (
       SELECT 1
       FROM tenants
       WHERE cost_allocation_revision <> 1
       LIMIT 1
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_COST_ALLOCATION_REQUIRE_REVIEW';
  END IF;
END
$$;

DROP TRIGGER tenant_cost_allocation_revisions_immutable_delete
  ON tenant_cost_allocation_revisions;
DROP TRIGGER tenant_cost_allocation_revisions_immutable_update
  ON tenant_cost_allocation_revisions;
DROP FUNCTION reject_tenant_cost_allocation_revision_mutation();
DROP TABLE tenant_cost_allocation_revisions;
DROP TABLE tenant_cost_centers;

DROP TRIGGER tenants_provision_cost_allocation_configuration ON tenants;
DROP FUNCTION provision_tenant_cost_allocation_configuration();
DROP TABLE tenant_cost_allocation_configuration;
