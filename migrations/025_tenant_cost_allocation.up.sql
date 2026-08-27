CREATE TABLE cost_centers (
  tenant_id uuid NOT NULL,
  id varchar(128) NOT NULL,
  code varchar(64) NOT NULL,
  name varchar(160) NOT NULL,
  description varchar(1000),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  CONSTRAINT cost_centers_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT cost_centers_id_valid CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cost_centers_code_valid CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CONSTRAINT cost_centers_name_valid CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT cost_centers_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000)
);

CREATE TABLE tenant_cost_allocation_policies (
  tenant_id uuid PRIMARY KEY,
  mode varchar(16) NOT NULL,
  default_cost_center_id varchar(128),
  updated_at timestamptz NOT NULL,
  CONSTRAINT tenant_cost_allocation_policy_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_cost_allocation_policy_mode_valid CHECK (mode IN ('disabled','optional','required')),
  CONSTRAINT tenant_cost_allocation_policy_default_fk
    FOREIGN KEY (tenant_id, default_cost_center_id) REFERENCES cost_centers(tenant_id, id) ON DELETE RESTRICT
);
