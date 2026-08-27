ALTER TABLE sites
  ADD COLUMN description varchar(1000),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT sites_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000);

ALTER TABLE rooms
  ADD COLUMN description varchar(1000),
  ADD COLUMN floor_label varchar(64),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT rooms_floor_label_valid CHECK (
    floor_label IS NULL OR char_length(btrim(floor_label)) BETWEEN 1 AND 64
  ),
  ADD CONSTRAINT rooms_sort_order_valid CHECK (sort_order BETWEEN 0 AND 100000);

CREATE TABLE room_service_availability (
  tenant_id uuid NOT NULL,
  room_id varchar(128) NOT NULL,
  service_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, room_id, service_id),
  CONSTRAINT room_service_availability_room_fk
    FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT room_service_availability_service_fk
    FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE room_catering_package_availability (
  tenant_id uuid NOT NULL,
  room_id varchar(128) NOT NULL,
  catering_package_id varchar(128) NOT NULL,
  PRIMARY KEY (tenant_id, room_id, catering_package_id),
  CONSTRAINT room_catering_package_availability_room_fk
    FOREIGN KEY (tenant_id, room_id) REFERENCES rooms(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT room_catering_package_availability_package_fk
    FOREIGN KEY (tenant_id, catering_package_id)
    REFERENCES catering_packages(tenant_id, id) ON DELETE RESTRICT
);
