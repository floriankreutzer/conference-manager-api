DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE cost_allocation_revision <> 1)
     OR EXISTS (SELECT 1 FROM tenant_cost_allocation_policies)
     OR EXISTS (SELECT 1 FROM cost_centers) THEN
    RAISE EXCEPTION 'TENANT_COST_ALLOCATION_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE tenant_cost_allocation_policies;
DROP TABLE cost_centers;
