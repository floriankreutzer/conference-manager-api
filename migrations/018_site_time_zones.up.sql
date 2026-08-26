ALTER TABLE sites
ADD COLUMN time_zone varchar(64);

ALTER TABLE sites
ADD CONSTRAINT sites_time_zone_valid CHECK (
  time_zone IS NULL
  OR (
    char_length(time_zone) BETWEEN 1 AND 64
    AND time_zone = btrim(time_zone)
    AND time_zone ~ '^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$'
  )
);
