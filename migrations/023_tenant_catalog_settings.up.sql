ALTER TABLE services
  ADD COLUMN description varchar(1000),
  ADD COLUMN billing_unit varchar(32) NOT NULL DEFAULT 'per_booking',
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT services_billing_unit_valid CHECK (billing_unit IN ('per_booking','per_person','per_day','per_unit')),
  ADD CONSTRAINT services_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000);

ALTER TABLE catering_packages
  ADD COLUMN description varchar(1000),
  ADD COLUMN billing_unit varchar(32) NOT NULL DEFAULT 'per_booking',
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT catering_packages_billing_unit_valid CHECK (billing_unit IN ('per_booking','per_person','per_day','per_unit')),
  ADD CONSTRAINT catering_packages_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000);

ALTER TABLE catering_items
  ADD COLUMN description varchar(1000),
  ADD COLUMN billing_unit varchar(32) NOT NULL DEFAULT 'per_unit',
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT catering_items_billing_unit_valid CHECK (billing_unit IN ('per_booking','per_person','per_day','per_unit')),
  ADD CONSTRAINT catering_items_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000);

CREATE TABLE catering_package_items (
  tenant_id uuid NOT NULL,
  catering_package_id varchar(128) NOT NULL,
  catering_item_id varchar(128) NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, catering_package_id, catering_item_id),
  CONSTRAINT catering_package_items_package_fk
    FOREIGN KEY (tenant_id, catering_package_id) REFERENCES catering_packages(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_package_items_item_fk
    FOREIGN KEY (tenant_id, catering_item_id) REFERENCES catering_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catering_package_items_quantity_valid CHECK (quantity BETWEEN 1 AND 1000)
);
